import {
	Plugin,
	App,
	TFile,
	TFolder,
	SuggestModal,
	AbstractInputSuggest,
	MarkdownView,
	Keymap,
	PluginSettingTab,
	Setting,
	Notice
} from 'obsidian';

import { UltraSearchSettings, DEFAULT_SETTINGS } from './settings';
import { SearchResult, fuzzyMatch, minPrefixLevenshteinDistance, getInOrderBonus, getMaxTypos } from './search';
import { UltraSearchChatView, CHAT_VIEW_TYPE } from './chatView';

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
		this.app.workspace.onLayoutReady(() => {
			void (async () => {
				statusBar.setText('UltraSearch: Indexing...');
				this.isIndexing = true;
				await this.buildIndex();
				this.isIndexing = false;
				statusBar.setText('UltraSearch: Ready');
				// Remove the status bar item after a short delay
				window.setTimeout(() => {
					statusBar.remove();
				}, 5000);
			})();
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

		// Register Chat View
		this.registerView(
			CHAT_VIEW_TYPE,
			(leaf) => new UltraSearchChatView(leaf, this)
		);

		// Ribbon icon for Chat panel
		this.addRibbonIcon('message-square', 'UltraSearch Chat', () => {
			void this.activateChatView();
		});

		// Command palette command for Chat panel
		this.addCommand({
			id: 'open-chat',
			name: 'Open Chat Panel',
			callback: () => {
				void this.activateChatView();
			}
		});

		// Settings tab registration
		this.addSettingTab(new UltraSearchSettingTab(this.app, this));

		// Register vault event handlers to update the index incrementally
		const isMdFile = (file: import('obsidian').TAbstractFile): file is TFile => file instanceof TFile && file.extension === 'md';

		this.registerEvent(this.app.vault.on('modify', (file) => {
			if (isMdFile(file)) void this.updateFileIndex(file);
		}));

		this.registerEvent(this.app.vault.on('create', (file) => {
			if (isMdFile(file)) void this.updateFileIndex(file);
		}));

		this.registerEvent(this.app.vault.on('delete', (file) => {
			if (isMdFile(file)) this.removeFileFromIndex(file.path);
		}));

		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			if (isMdFile(file)) {
				this.removeFileFromIndex(oldPath);
				void this.updateFileIndex(file);
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

	async activateChatView() {
		const { workspace } = this.app;

		let leaf = workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0];
		if (!leaf) {
			const rightLeaf = workspace.getRightLeaf(false);
			if (rightLeaf) {
				leaf = rightLeaf;
				await leaf.setViewState({
					type: CHAT_VIEW_TYPE,
					active: true
				});
			}
		}

		if (leaf) {
			workspace.revealLeaf(leaf);
		}
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
	private footerEl: HTMLElement | null = null;

	constructor(app: App, plugin: UltraSearchPlugin) {
		super(app);
		this.plugin = plugin;
		this.setPlaceholder('Type to search...');
		this.emptyStateText = 'No matching results found.';
	}
	onClose() {
	}

	onOpen() {
		void super.onOpen();

		// Add footer color coding legend at the bottom of the modal window
		this.footerEl = this.modalEl.createDiv({ cls: 'ultra-search-footer' });

		this.footerEl.createSpan({ cls: 'ultra-search-legend-title', text: 'Search Types: ' });

		this.footerEl.createSpan({ cls: 'ultra-search-badge badge-line', text: 'Line' });
		this.footerEl.createSpan({ cls: 'ultra-search-legend-desc', text: ' Line Match' });

		this.footerEl.createSpan({ cls: 'ultra-search-badge badge-file', text: 'File' });
		this.footerEl.createSpan({ cls: 'ultra-search-legend-desc', text: ' File Name Match' });
	}

	getSuggestions(query: string): SearchResult[] | Promise<SearchResult[]> {

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
}

class FolderSuggest extends AbstractInputSuggest<string> {
	private inputEl: HTMLInputElement;

	constructor(app: App, inputEl: HTMLInputElement) {
		super(app, inputEl);
		this.inputEl = inputEl;
	}

	getSuggestions(query: string): string[] {
		const cursor = this.inputEl.selectionStart ?? query.length;
		const beforeText = query.substring(0, cursor);
		const lastCommaBefore = beforeText.lastIndexOf(',');

		const afterText = query.substring(cursor);
		const nextCommaAfter = afterText.indexOf(',');
		const lastCommaAfter = nextCommaAfter === -1 ? query.length : cursor + nextCommaAfter;

		const currentSegment = query.substring(lastCommaBefore + 1, lastCommaAfter).trim().toLowerCase();

		const folders = this.app.vault.getAllLoadedFiles()
			.filter((file): file is TFolder => file instanceof TFolder && !file.isRoot())
			.map(folder => folder.path);

		return folders
			.filter(path => path.toLowerCase().includes(currentSegment))
			.sort((a, b) => a.localeCompare(b));
	}

	renderSuggestion(value: string, el: HTMLElement): void {
		el.setText(value);
	}

	selectSuggestion(value: string, evt: MouseEvent | KeyboardEvent): void {
		const currentVal = this.inputEl.value;
		const cursor = this.inputEl.selectionStart ?? currentVal.length;

		const beforeText = currentVal.substring(0, cursor);
		const lastCommaBefore = beforeText.lastIndexOf(',');

		const afterText = currentVal.substring(cursor);
		const nextCommaAfter = afterText.indexOf(',');
		const lastCommaAfter = nextCommaAfter === -1 ? currentVal.length : cursor + nextCommaAfter;

		const beforeSegment = currentVal.substring(0, lastCommaBefore + 1);
		const afterSegment = currentVal.substring(lastCommaAfter);

		let leading = beforeSegment;
		if (leading.endsWith(',')) {
			leading += ' ';
		}

		let newVal = '';
		let cursorPosition = 0;
		if (afterSegment.trim().length === 0) {
			newVal = leading + value + ', ';
			cursorPosition = newVal.length;
		} else {
			newVal = leading + value + afterSegment;
			cursorPosition = leading.length + value.length;
		}

		this.setValue(newVal);

		this.inputEl.focus();
		this.inputEl.setSelectionRange(cursorPosition, cursorPosition);

		this.inputEl.dispatchEvent(new Event('input'));
		this.close();
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
			.addText(text => {
				text.setPlaceholder('templates, archives')
					.setValue(this.plugin.settings.excludeFolders)
					.onChange((value) => {
						this.plugin.settings.excludeFolders = value;
						void this.plugin.saveSettings();
						// Rebuild index in the background to apply exclusions
						void this.plugin.buildIndex();
					});
				new FolderSuggest(this.app, text.inputEl);
			});

		new Setting(containerEl)
			.setName('Gemini API Key Secret')
			.setDesc('Select the Secret ID from your Obsidian Keychain that contains your Gemini API key.')
			.addDropdown(dropdown => {
				const secrets = this.app.secretStorage.listSecrets();
				dropdown.addOption('', 'Select a secret...');
				secrets.forEach(secretId => { dropdown.addOption(secretId, secretId); });
				dropdown.setValue(this.plugin.settings.geminiSecretId)
					.onChange((value) => {
						this.plugin.settings.geminiSecretId = value;
						void this.plugin.saveSettings();
					});
			});
	}
}
