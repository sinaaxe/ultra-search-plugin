import {
	Plugin,
	App,
	TFile,
	SuggestModal,
	MarkdownView,
	Keymap,
	PluginSettingTab,
	Setting
} from 'obsidian';

// Settings interface
interface UltraSearchSettings {
	maxResults: number;
	minQueryLength: number;
	excludeFolders: string;
}

const DEFAULT_SETTINGS: UltraSearchSettings = {
	maxResults: 10,
	minQueryLength: 1,
	excludeFolders: ''
};

// Cached representation of a line
interface IndexedLine {
	text: string;
	lowerText: string;
	lineNumber: number;
}

// Search result item
interface LineSearchResult {
	file: TFile;
	lineNumber: number;
	text: string;
	score: number;
}

// Prefix Levenshtein Distance for typo-tolerant matching
function minPrefixLevenshteinDistance(word: string, query: string): number {
	if (query.length === 0) return 0;
	if (word.length === 0) return query.length;

	let prevRow: number[] = Array<number>(word.length + 1).fill(0);
	let currRow: number[] = Array<number>(word.length + 1).fill(0);

	for (let i = 1; i <= query.length; i++) {
		currRow[0] = i;
		for (let j = 1; j <= word.length; j++) {
			const indicator = query[i - 1] === word[j - 1] ? 0 : 1;
			currRow[j] = Math.min(
				prevRow[j]! + 1, // deletion
				currRow[j - 1]! + 1, // insertion
				prevRow[j - 1]! + indicator // substitution
			);
		}
		const temp = prevRow;
		prevRow = currRow;
		currRow = temp;
	}

	return Math.min(...prevRow);
}

// Word-level typo-tolerant fuzzy match with scoring
function fuzzyMatch(textLower: string, queryLower: string): { matches: boolean; score: number } {
	const qLen = queryLower.length;
	if (qLen === 0) return { matches: true, score: 0 };

	// Exact substring matches get highest score
	const subIdx = textLower.indexOf(queryLower);
	if (subIdx !== -1) {
		let score = 80;
		if (subIdx === 0 || !/[a-z0-9]/.test(textLower[subIdx - 1] || ' ')) {
			score += 15;
		}
		score += qLen * 2;
		return { matches: true, score };
	}

	let maxTypos = 0;
	if (qLen >= 3 && qLen <= 5) maxTypos = 1;
	else if (qLen >= 6) maxTypos = 2;

	if (maxTypos === 0) {
		return { matches: false, score: 0 };
	}

	const words = textLower.split(/[^a-z0-9]+/);
	let bestDist = Infinity;

	for (const word of words) {
		if (word.length === 0) continue;

		const dist = minPrefixLevenshteinDistance(word, queryLower);
		if (dist <= maxTypos && dist < bestDist) {
			bestDist = dist;
		}
	}

	if (bestDist <= maxTypos) {
		const score = 50 - (bestDist * 10) + (qLen * 2);
		return { matches: true, score: Math.max(1, score) };
	}

	return { matches: false, score: 0 };
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
		this.registerEvent(this.app.vault.on('modify', async (file) => {
			if (file instanceof TFile && file.extension === 'md') {
				await this.updateFileIndex(file);
			}
		}));

		this.registerEvent(this.app.vault.on('create', async (file) => {
			if (file instanceof TFile && file.extension === 'md') {
				await this.updateFileIndex(file);
			}
		}));

		this.registerEvent(this.app.vault.on('delete', (file) => {
			if (file instanceof TFile && file.extension === 'md') {
				this.removeFileFromIndex(file.path);
			}
		}));

		this.registerEvent(this.app.vault.on('rename', async (file, oldPath) => {
			if (file instanceof TFile && file.extension === 'md') {
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
class UltraSearchModal extends SuggestModal<LineSearchResult> {
	plugin: UltraSearchPlugin;
	terms: string[] = [];

	constructor(app: App, plugin: UltraSearchPlugin) {
		super(app);
		this.plugin = plugin;
		this.setPlaceholder('Type to search (fuzzy, typo-tolerant & out of order)...');
		this.emptyStateText = 'No matching results found.';
	}

	getSuggestions(query: string): LineSearchResult[] {
		const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);
		this.terms = terms;

		if (terms.length < this.plugin.settings.minQueryLength) {
			return [];
		}

		const results: LineSearchResult[] = [];

		for (const [filePath, lines] of this.plugin.index.entries()) {
			const file = this.app.vault.getAbstractFileByPath(filePath);
			if (!file || !(file instanceof TFile)) continue;

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
					// Order bonus: if terms appear in the same order as in the query
					if (terms.length > 1) {
						let lastIdx = -1;
						let inOrder = true;
						for (const term of terms) {
							const idx = line.lowerText.indexOf(term);
							if (idx !== -1 && idx > lastIdx) {
								lastIdx = idx;
							} else {
								inOrder = false;
								break;
							}
						}
						if (inOrder) {
							totalScore += 20;
						}
					}

					// Penalize long lines slightly to prioritize shorter ones
					totalScore -= line.text.length * 0.01;

					results.push({
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

	renderSuggestion(suggestion: LineSearchResult, el: HTMLElement) {
		el.addClass('ultra-search-suggestion');
		const contentEl = el.createDiv({ cls: 'suggestion-content' });
		const titleEl = contentEl.createDiv({ cls: 'suggestion-title' });

		// Custom highlighter rendering
		this.renderHighlightedText(titleEl, suggestion.text, this.terms);

		const noteEl = contentEl.createDiv({ cls: 'suggestion-note' });
		noteEl.createSpan({ cls: 'ultra-search-file', text: suggestion.file.path });
		noteEl.createSpan({ cls: 'ultra-search-separator', text: ' : ' });
		noteEl.createSpan({ cls: 'ultra-search-linenumber', text: `Line ${suggestion.lineNumber}` });
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
							let maxTypos = 0;
							if (term.length >= 3 && term.length <= 5) maxTypos = 1;
							else if (term.length >= 6) maxTypos = 2;

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
	onChooseSuggestion(suggestion: LineSearchResult, evt: MouseEvent | KeyboardEvent): void {
		const leaf = this.app.workspace.getLeaf(Keymap.isModifier(evt, 'Mod'));

		const openAndScroll = async () => {
			await leaf.openFile(suggestion.file, { state: { mode: 'source' } });
			const setEditorCursor = () => {
				const view = leaf.view;
				if (view instanceof MarkdownView) {
					const editor = view.editor;
					const pos = { line: suggestion.lineNumber - 1, ch: 0 };
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
		};

		void openAndScroll();
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
				.onChange(async (value) => {
					const num = parseInt(value, 10);
					if (!isNaN(num) && num >= 1) {
						this.plugin.settings.minQueryLength = num;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName('Maximum results')
			.setDesc('Maximum number of matching results to display.')
			.addText(text => text
				.setPlaceholder('10')
				.setValue(String(this.plugin.settings.maxResults))
				.onChange(async (value) => {
					const num = parseInt(value, 10);
					if (!isNaN(num) && num >= 1) {
						this.plugin.settings.maxResults = num;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName('Exclude folders')
			.setDesc('Comma-separated list of folders to exclude from search (e.g. templates, archives).')
			.addText(text => text
				.setPlaceholder('templates, archives')
				.setValue(this.plugin.settings.excludeFolders)
				.onChange(async (value) => {
					this.plugin.settings.excludeFolders = value;
					await this.plugin.saveSettings();
					// Rebuild index in the background to apply exclusions
					void this.plugin.buildIndex();
				}));
	}
}
