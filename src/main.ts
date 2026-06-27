import {
	Plugin,
	App,
	TFile,
	SuggestModal,
	MarkdownView,
	Keymap,
	PluginSettingTab,
	Setting,
	Notice,
	MarkdownRenderer,
	Component
} from 'obsidian';

import { UltraSearchSettings, DEFAULT_SETTINGS } from './settings';
import { SearchResult, fuzzyMatch, minPrefixLevenshteinDistance, getInOrderBonus, getMaxTypos } from './search';
import { performGeminiSearch } from './gemini';

// Cached representation of a line
interface IndexedLine {
	text: string;
	lowerText: string;
	lineNumber: number;
}

// Core Plugin Class
export default class UltraSearchPlugin extends Plugin {
	settings!: UltraSearchSettings;
	index: Map<string, IndexedLine[]> = new Map();
	isIndexing = false;

	async onload() {
		await this.loadSettings();

		// Add status bar indicator
		const statusBar = this.addStatusBarItem();
		statusBar.setText('UltraSearch: Initializing...');

		// Index files when workspace is ready
		this.app.workspace.onLayoutReady(async () => {
			statusBar.setText('UltraSearch: Indexing...');
			this.isIndexing = true;
			await this.buildIndex();
			this.isIndexing = false;
			statusBar.setText('UltraSearch: Ready');
			// Remove the status bar item after a short delay
			window.setTimeout(() => {
				statusBar.remove();
			}, 5000);
		});

		// Ribbon icon for quick access
		this.addRibbonIcon('search', 'UltraSearch', () => {
			new UltraSearchModal(this.app, this).open();
		});

		// Command palette command
		this.addCommand({
			id: 'open',
			name: 'Open',
			callback: () => {
				new UltraSearchModal(this.app, this).open();
			}
		});

		// Settings tab registration
		this.addSettingTab(new UltraSearchSettingTab(this.app, this));

		// Register vault event handlers to update the index incrementally
		const isMdFile = (file: import('obsidian').TAbstractFile): file is TFile => file instanceof TFile && file.extension === 'md';

		this.registerEvent(this.app.vault.on('modify', async (file) => {
			if (isMdFile(file)) await this.updateFileIndex(file);
		}));

		this.registerEvent(this.app.vault.on('create', async (file) => {
			if (isMdFile(file)) await this.updateFileIndex(file);
		}));

		this.registerEvent(this.app.vault.on('delete', (file) => {
			if (isMdFile(file)) this.removeFileFromIndex(file.path);
		}));

		this.registerEvent(this.app.vault.on('rename', async (file, oldPath) => {
			if (isMdFile(file)) {
				this.removeFileFromIndex(oldPath);
				await this.updateFileIndex(file);
			}
		}));
	}

	async loadSettings() {
		const loadedData = (await this.loadData()) as Partial<UltraSearchSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// Folder exclusion utility
	isFolderExcluded(path: string, excludeFoldersStr: string): boolean {
		if (!excludeFoldersStr) return false;
		const excluded = excludeFoldersStr.split(',').map(f => f.trim().toLowerCase()).filter(f => f.length > 0);
		const lowerPath = path.toLowerCase();
		for (const folder of excluded) {
			if (lowerPath === folder || lowerPath.startsWith(folder + '/')) {
				return true;
			}
		}
		return false;
	}

	// Reads and caches all markdown files in the vault
	async buildIndex() {
		const files = this.app.vault.getMarkdownFiles();
		this.index.clear();

		const batchSize = 100;
		for (let i = 0; i < files.length; i += batchSize) {
			const batch = files.slice(i, i + batchSize);
			await Promise.all(batch.map(async (file) => {
				if (this.isFolderExcluded(file.path, this.settings.excludeFolders)) {
					return;
				}
				await this.updateFileIndex(file);
			}));
		}
	}

	// Read and parse an individual file into our lines cache
	async updateFileIndex(file: TFile) {
		if (this.isFolderExcluded(file.path, this.settings.excludeFolders)) {
			this.index.delete(file.path);
			return;
		}
		try {
			const content = await this.app.vault.read(file);
			const lines: IndexedLine[] = [];
			const rawLines = content.split(/\r?\n/);
			for (let i = 0; i < rawLines.length; i++) {
				const text = rawLines[i]!.trim();
				if (text.length > 0) {
					lines.push({
						text,
						lowerText: text.toLowerCase(),
						lineNumber: i + 1
					});
				}
			}
			this.index.set(file.path, lines);
		} catch (e) {
			console.error(`[UltraSearch] Error reading file ${file.path}:`, e);
		}
	}

	removeFileFromIndex(path: string) {
		this.index.delete(path);
	}
}

// Suggestion Modal Implementation
class UltraSearchModal extends SuggestModal<SearchResult> {
	plugin: UltraSearchPlugin;
	terms: string[] = [];

	// Performance state variables
	private searchTimeoutId: number | null = null;
	private activeResolve: ((value: SearchResult[]) => void) | null = null;
	private lastQuery = '';
	private lastResults: SearchResult[] = [];

	// Gemini state
	private searchMode: 'fuzzy' | 'gemini' = 'fuzzy';
	private geminiContextMode: 'file' | 'folder' | 'vault' = 'file';
	private geminiIncludeReferences = false;
	private isGenerating = false;
	private geminiContainerEl: HTMLElement | null = null;
	private geminiToolbarEl: HTMLElement | null = null;
	private geminiResultEl: HTMLElement | null = null;
	private footerEl: HTMLElement | null = null;
	private geminiReferenceResults: SearchResult[] = [];
	private lastGeminiQuery: string = '';
	private currentApiKey: string | null = null;
	private renderComponents: Component[] = [];

	constructor(app: App, plugin: UltraSearchPlugin) {
		super(app);
		this.plugin = plugin;
		this.setPlaceholder('Type to search (fuzzy, typo-tolerant & out of order)... (Press Tab to switch)');
		this.emptyStateText = 'No matching results found.';
	}
	onClose() {
		this.renderComponents.forEach(c => c.unload());
	}

	onOpen() {
		void super.onOpen();

		const secretId = this.plugin.settings.geminiSecretId;
		const rawApiKey = secretId ? this.plugin.app.secretStorage.getSecret(secretId) : null;
		this.currentApiKey = rawApiKey ? rawApiKey : null;

		this.scope.register([], 'Tab', (e: KeyboardEvent) => {
			this.searchMode = this.searchMode === 'fuzzy' ? 'gemini' : 'fuzzy';
			this.updateModeUI();
			return false;
		});

		this.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' && this.searchMode === 'gemini') {
				if (this.geminiReferenceResults.length === 0) {
					e.preventDefault();
					e.stopPropagation();
					void this.triggerGeminiSearch();
				}
			}
		}, { capture: true });

		const promptContainer = this.resultContainerEl.parentElement || this.modalEl;
		if (promptContainer) {
			this.geminiContainerEl = createDiv({ cls: 'ultra-search-gemini-container gemini-hidden' });
			promptContainer.insertBefore(this.geminiContainerEl, this.resultContainerEl);

			const toolbarEl = this.geminiContainerEl.createDiv({ cls: 'gemini-toolbar' });
			this.geminiToolbarEl = toolbarEl;

			const controlsWrapper = toolbarEl.createDiv({ cls: 'gemini-controls-wrapper' });

			const contextWrapper = controlsWrapper.createDiv();
			contextWrapper.createSpan({ text: 'Context: ', cls: 'gemini-context-label' });

			const contextDropdownEl = contextWrapper.createEl('select', { cls: 'gemini-context-dropdown' });
			contextDropdownEl.createEl('option', { value: 'file', text: 'Current File' });
			contextDropdownEl.createEl('option', { value: 'folder', text: 'Current Folder' });
			contextDropdownEl.createEl('option', { value: 'vault', text: 'Entire Vault' });
			contextDropdownEl.addEventListener('change', (e) => {
				this.geminiContextMode = (e.target as HTMLSelectElement).value as 'file' | 'folder' | 'vault';
			});

			const includeRefsWrapper = controlsWrapper.createDiv({ cls: 'gemini-include-refs-wrapper' });
			const includeRefsCheckbox = includeRefsWrapper.createEl('input', { type: 'checkbox' });
			includeRefsCheckbox.addEventListener('change', (e) => {
				this.geminiIncludeReferences = (e.target as HTMLInputElement).checked;
			});
			includeRefsWrapper.createSpan({ text: 'Include Linked Pages', cls: 'gemini-include-refs-label', attr: { style: 'font-size: 0.9em; color: var(--text-muted);' } });

			const modelWrapper = controlsWrapper.createDiv();
			modelWrapper.createSpan({ text: 'Model: ', cls: 'gemini-model-label' });

			const modelDropdownEl = modelWrapper.createEl('select', { cls: 'gemini-model-dropdown' });
			modelDropdownEl.createEl('option', { value: 'gemini-3.5-flash', text: 'Gemini 3.5 Flash' });
			modelDropdownEl.createEl('option', { value: 'gemini-3.1-pro', text: 'Gemini 3.1 Pro' });
			modelDropdownEl.createEl('option', { value: 'gemini-3.1-flash-lite', text: 'Gemini 3.1 Flash Lite' });
			modelDropdownEl.value = this.plugin.settings.geminiModel;
			modelDropdownEl.addEventListener('change', (e) => {
				this.plugin.settings.geminiModel = (e.target as HTMLSelectElement).value;
				void this.plugin.saveSettings();
			});

			const searchBtn = toolbarEl.createEl('button', { text: 'Ask Gemini', cls: 'mod-cta' });
			searchBtn.addEventListener('click', () => void this.triggerGeminiSearch());

			this.geminiResultEl = this.geminiContainerEl.createDiv({ cls: 'gemini-result markdown-rendered' });
		}

		// Add footer color coding legend at the bottom of the modal window
		this.footerEl = this.modalEl.createDiv({ cls: 'ultra-search-footer' });

		this.footerEl.createSpan({ cls: 'ultra-search-legend-title', text: 'Search Types: ' });

		this.footerEl.createSpan({ cls: 'ultra-search-badge badge-line', text: 'Line' });
		this.footerEl.createSpan({ cls: 'ultra-search-legend-desc', text: ' Line Match' });

		this.footerEl.createSpan({ cls: 'ultra-search-badge badge-file', text: 'File' });
		this.footerEl.createSpan({ cls: 'ultra-search-legend-desc', text: ' File Name Match' });
	}

	getSuggestions(query: string): SearchResult[] | Promise<SearchResult[]> {
		if (this.searchMode === 'gemini') {
			if (this.currentApiKey && query !== this.lastGeminiQuery) {
				this.geminiReferenceResults = [];
				if (this.geminiResultEl) {
					this.geminiResultEl.empty();
				}
			}
			return this.geminiReferenceResults;
		}

		// Clean the query terms for highlighting
		const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);
		this.terms = terms;

		if (terms.length < this.plugin.settings.minQueryLength) {
			if (this.searchTimeoutId !== null) {
				window.clearTimeout(this.searchTimeoutId);
				this.searchTimeoutId = null;
			}
			if (this.activeResolve) {
				this.activeResolve([]);
				this.activeResolve = null;
			}
			this.lastQuery = '';
			this.lastResults = [];
			return [];
		}

		// Cache optimization: If query hasn't changed, return cached results immediately
		if (query === this.lastQuery) {
			return this.lastResults;
		}

		// Cancel existing timeout and resolve previous search promise with empty list
		if (this.searchTimeoutId !== null) {
			window.clearTimeout(this.searchTimeoutId);
		}
		if (this.activeResolve) {
			this.activeResolve([]);
			this.activeResolve = null;
		}

		// Return debounced promise (200ms delay) to prevent UI block while typing
		return new Promise((resolve) => {
			this.activeResolve = resolve;
			this.searchTimeoutId = window.setTimeout(() => {
				const results = this.performSearch(query);
				this.lastQuery = query;
				this.lastResults = results;
				this.activeResolve = null;
				this.searchTimeoutId = null;
				resolve(results);
			}, 200);
		});
	}

	private performSearch(query: string): SearchResult[] {
		const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);
		const results: SearchResult[] = [];

		for (const [filePath, lines] of this.plugin.index.entries()) {
			const file = this.app.vault.getAbstractFileByPath(filePath);
			if (!file || !(file instanceof TFile)) continue;

			// 1. Match File Name
			let fileMatchesAll = true;
			let fileTotalScore = 0;
			const fileLower = file.name.toLowerCase();

			for (const term of terms) {
				const match = fuzzyMatch(fileLower, term);
				if (!match.matches) {
					fileMatchesAll = false;
					break;
				}
				fileTotalScore += match.score;
			}

			if (fileMatchesAll) {
				fileTotalScore += getInOrderBonus(fileLower, terms);

				// Penalize long file names slightly to prioritize shorter ones
				fileTotalScore -= file.name.length * 0.01;

				// Give file name match a slight boost so it ranks higher than individual line matches
				fileTotalScore += 10;

				results.push({
					type: 'file',
					file,
					text: file.name,
					score: fileTotalScore
				});
			}

			// 2. Match Lines
			for (const line of lines) {
				let matchesAll = true;
				let totalScore = 0;

				for (const term of terms) {
					// Compute matching score using typo-tolerant fuzzy match
					const match = fuzzyMatch(line.lowerText, term);
					if (!match.matches) {
						matchesAll = false;
						break;
					}
					totalScore += match.score;
				}

				if (matchesAll) {
					totalScore += getInOrderBonus(line.lowerText, terms);

					// Penalize long lines slightly to prioritize shorter ones
					totalScore -= line.text.length * 0.01;

					results.push({
						type: 'line',
						file,
						lineNumber: line.lineNumber,
						text: line.text,
						score: totalScore
					});
				}
			}
		}

		// Sort by score descending
		results.sort((a, b) => b.score - a.score);

		return results.slice(0, this.plugin.settings.maxResults);
	}

	renderSuggestion(suggestion: SearchResult, el: HTMLElement) {
		el.addClass('ultra-search-suggestion');
		const contentEl = el.createDiv({ cls: 'suggestion-content' });
		const titleEl = contentEl.createDiv({ cls: 'suggestion-title' });

		// Custom highlighter rendering
		this.renderHighlightedText(titleEl, suggestion.text, this.terms);

		const noteEl = contentEl.createDiv({ cls: 'suggestion-note' });
		noteEl.createSpan({ cls: 'ultra-search-file', text: suggestion.file.path });

		if (suggestion.type === 'line' && suggestion.lineNumber !== undefined) {
			noteEl.createSpan({ cls: 'ultra-search-separator', text: ' : ' });
			noteEl.createSpan({ cls: 'ultra-search-linenumber', text: `Line ${suggestion.lineNumber}` });
		}

		// Create badge on the right
		const badgeClass = suggestion.type === 'line' ? 'badge-line' : 'badge-file';
		const badgeText = suggestion.type === 'line' ? 'Line' : 'File';
		el.createDiv({ cls: `ultra-search-badge ${badgeClass}`, text: badgeText });
	}

	// Custom inline text highlighter
	renderHighlightedText(parentEl: HTMLElement, text: string, terms: string[]) {
		const highlighted: boolean[] = new Array<boolean>(text.length).fill(false);
		const lowerText = text.toLowerCase();

		for (const term of terms) {
			const subIdx = lowerText.indexOf(term);
			if (subIdx !== -1) {
				for (let i = 0; i < term.length; i++) {
					highlighted[subIdx + i] = true;
				}
			} else {
				// Fallback to typo-tolerant highlight
				let bestDist = Infinity;
				let matchStart = -1;
				let matchEnd = -1;

				let currentWordStart = -1;
				for (let i = 0; i <= lowerText.length; i++) {
					const char = i < lowerText.length ? (lowerText[i] || ' ') : ' ';
					const isAlphanumeric = /[a-z0-9]/.test(char);

					if (isAlphanumeric) {
						if (currentWordStart === -1) currentWordStart = i;
					} else {
						if (currentWordStart !== -1) {
							const word = lowerText.substring(currentWordStart, i);
							const dist = minPrefixLevenshteinDistance(word, term);
							const maxTypos = getMaxTypos(term.length);

							if (dist <= maxTypos && dist < bestDist) {
								bestDist = dist;
								matchStart = currentWordStart;
								matchEnd = Math.min(i, currentWordStart + term.length + dist);
							}
							currentWordStart = -1;
						}
					}
				}

				if (matchStart !== -1 && matchEnd !== -1) {
					for (let i = matchStart; i < matchEnd; i++) {
						highlighted[i] = true;
					}
				}
			}
		}

		let currentSpan: HTMLElement | null = null;
		let isHighlighted = false;

		for (let i = 0; i < text.length; i++) {
			const char = text[i]!;
			const needHighlight = highlighted[i]!;

			if (needHighlight !== isHighlighted) {
				isHighlighted = needHighlight;
				if (isHighlighted) {
					currentSpan = parentEl.createSpan({ cls: 'suggestion-highlight' });
				} else {
					currentSpan = null;
				}
			}

			if (currentSpan) {
				currentSpan.textContent += char;
			} else {
				parentEl.appendText(char);
			}
		}
	}

	// Navigate to selected file and line
	onChooseSuggestion(suggestion: SearchResult, evt: MouseEvent | KeyboardEvent): void {
		const leaf = this.app.workspace.getLeaf(Keymap.isModifier(evt, 'Mod'));

		const openAndScroll = async () => {
			if (suggestion.file instanceof TFile) {
				await leaf.openFile(suggestion.file, { state: { mode: 'source' } });

				if (suggestion.type === 'line' && suggestion.lineNumber !== undefined) {
					const setEditorCursor = () => {
						const view = leaf.view;
						if (view instanceof MarkdownView) {
							const editor = view.editor;
							const pos = { line: suggestion.lineNumber! - 1, ch: 0 };
							editor.setCursor(pos);
							editor.scrollIntoView({ from: pos, to: pos }, true);
							editor.focus();
							return true;
						}
						return false;
					};

					// Try setting cursor immediately
					if (!setEditorCursor()) {
						// Fallback with a short delay if editor was not yet instantiated
						window.setTimeout(() => {
							setEditorCursor();
						}, 50);
					}
				}
			}
		};

		void openAndScroll();
	}

	updateModeUI() {
		if (this.searchMode === 'gemini') {
			this.setPlaceholder('Ask Gemini (Press Tab to switch to Fuzzy Search)...');
			this.emptyStateText = '';
			this.resultContainerEl.toggleClass('gemini-hidden', false);
			if (this.footerEl) this.footerEl.toggleClass('gemini-hidden', true);
			if (this.geminiContainerEl) {
				this.geminiContainerEl.toggleClass('gemini-hidden', false);

				if (!this.currentApiKey) {
					if (this.geminiToolbarEl) this.geminiToolbarEl.toggleClass('gemini-hidden', true);
					if (this.geminiResultEl) {
						this.geminiResultEl.empty();
						const warningEl = this.geminiResultEl.createDiv({ cls: 'gemini-warning' });
						warningEl.createEl('strong', { text: 'Gemini Search Disabled' });
						warningEl.createEl('br');
						warningEl.appendText('Please select and set a valid Gemini API Key secret in the plugin settings.');
					}
				} else {
					if (this.geminiToolbarEl) this.geminiToolbarEl.toggleClass('gemini-hidden', false);
				}
			}
			this.inputEl.dispatchEvent(new Event('input'));
		} else {
			this.setPlaceholder('Type to search (fuzzy, typo-tolerant & out of order)... (Press Tab to switch)');
			this.emptyStateText = 'No matching results found.';
			this.resultContainerEl.toggleClass('gemini-hidden', false);
			if (this.footerEl) this.footerEl.toggleClass('gemini-hidden', false);
			if (this.geminiContainerEl) this.geminiContainerEl.toggleClass('gemini-hidden', true);
			this.inputEl.dispatchEvent(new Event('input'));
		}
	}

	async triggerGeminiSearch() {
		if (this.isGenerating) return;
		const query = this.inputEl.value.trim();
		if (!query) {
			new Notice('Please enter a query for Gemini.');
			return;
		}

		this.lastGeminiQuery = query;

		if (!this.currentApiKey) {
			new Notice('Please select and set a valid Gemini API Key secret in the settings.');
			return;
		}

		this.isGenerating = true;
		this.geminiReferenceResults = [];
		if (this.geminiResultEl) {
			this.geminiResultEl.empty();
			this.geminiResultEl.createEl('div', { text: 'Gathering context and asking Gemini...' });
		}

		try {
			const { answer, references } = await performGeminiSearch(
				this.app,
				this.plugin,
				query,
				this.geminiContextMode,
				this.geminiIncludeReferences,
				this.currentApiKey,
				this.plugin.settings.geminiModel
			);

			if (this.geminiResultEl) {
				this.geminiResultEl.empty();
				if (answer) {
					const comp = new Component();
					comp.load();
					this.renderComponents.push(comp);
					await MarkdownRenderer.render(this.app, answer, this.geminiResultEl, '', comp);
				}

				if (references.length > 0) {
					this.geminiReferenceResults = references;
				}

				this.inputEl.dispatchEvent(new Event('input'));
			}
		} catch (error) {
			console.error(error);
			const errMsg = error instanceof Error ? error.message : String(error);
			new Notice('Gemini search failed: ' + errMsg);
			if (this.geminiResultEl) {
				this.geminiResultEl.empty();
				this.geminiResultEl.createEl('div', { text: 'Error: ' + errMsg, cls: 'gemini-error' });
			}
		} finally {
			this.isGenerating = false;
		}
	}
}

// Settings Tab UI
class UltraSearchSettingTab extends PluginSettingTab {
	plugin: UltraSearchPlugin;

	constructor(app: App, plugin: UltraSearchPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Minimum query length')
			.setDesc('Minimum number of characters to type before triggering search.')
			.addText(text => text
				.setPlaceholder('1')
				.setValue(String(this.plugin.settings.minQueryLength))
				.onChange((value) => {
					const num = parseInt(value, 10);
					if (!isNaN(num) && num >= 1) {
						this.plugin.settings.minQueryLength = num;
						void this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName('Maximum results')
			.setDesc('Maximum number of matching results to display.')
			.addText(text => text
				.setPlaceholder('10')
				.setValue(String(this.plugin.settings.maxResults))
				.onChange((value) => {
					const num = parseInt(value, 10);
					if (!isNaN(num) && num >= 1) {
						this.plugin.settings.maxResults = num;
						void this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName('Exclude folders')
			.setDesc('Comma-separated list of folders to exclude from search (e.g. templates, archives).')
			.addText(text => text
				.setPlaceholder('templates, archives')
				.setValue(this.plugin.settings.excludeFolders)
				.onChange((value) => {
					this.plugin.settings.excludeFolders = value;
					void this.plugin.saveSettings();
					// Rebuild index in the background to apply exclusions
					void this.plugin.buildIndex();
				}));

		new Setting(containerEl)
			.setName('Gemini API Key Secret')
			.setDesc('Select the Secret ID from your Obsidian Keychain that contains your Gemini API key.')
			.addDropdown(dropdown => {
				const secrets = this.app.secretStorage.listSecrets();
				dropdown.addOption('', 'Select a secret...');
				secrets.forEach(secretId => dropdown.addOption(secretId, secretId));
				dropdown.setValue(this.plugin.settings.geminiSecretId)
					.onChange((value) => {
						this.plugin.settings.geminiSecretId = value;
						void this.plugin.saveSettings();
					});
			});
	}
}
