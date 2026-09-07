import { ItemView, WorkspaceLeaf, Component, MarkdownRenderer, Notice, TFile, MarkdownView } from 'obsidian';
import type UltraSearchPlugin from './main';
import { performGeminiChat } from './gemini';
import type { ChatReference } from './types';

export const CHAT_VIEW_TYPE = 'ultra-search-chat-view';

interface ChatMessage {
	role: 'user' | 'model';
	text: string;     // The raw text or response representation (for user, query. For model, the raw JSON string)
	answer: string;   // The clean answer markdown text
	references?: ChatReference[];
}

export class UltraSearchChatView extends ItemView {
	plugin: UltraSearchPlugin;
	history: ChatMessage[] = [];
	isGenerating = false;

	// UI Elements
	chatHistoryEl!: HTMLElement;
	inputEl!: HTMLTextAreaElement;
	sendBtnEl!: HTMLButtonElement;
	contextDropdownEl!: HTMLSelectElement;
	includeRefsCheckbox!: HTMLInputElement;
	googleSearchCheckbox!: HTMLInputElement;
	modelDropdownEl!: HTMLSelectElement;
	clearBtnEl!: HTMLButtonElement;
	renderComponents: Component[] = [];

	constructor(leaf: WorkspaceLeaf, plugin: UltraSearchPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return CHAT_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'UltraSearch Chat';
	}

	getIcon(): string {
		return 'message-square';
	}

	async onOpen() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass('ultra-search-chat-container');

		// Create Settings / Toolbar area
		const toolbarEl = container.createDiv({ cls: 'chat-toolbar' });

		// Context Selector
		const contextWrapper = toolbarEl.createDiv({ cls: 'chat-control-item' });
		contextWrapper.createSpan({ text: 'Context: ', cls: 'chat-label' });
		this.contextDropdownEl = contextWrapper.createEl('select', { cls: 'chat-select' });
		this.contextDropdownEl.createEl('option', { value: 'file', text: 'Current File' });
		this.contextDropdownEl.createEl('option', { value: 'folder', text: 'Current Folder' });
		this.contextDropdownEl.createEl('option', { value: 'vault', text: 'Entire Vault' });

		// Include references
		const includeRefsWrapper = toolbarEl.createDiv({ cls: 'chat-control-item chat-checkbox-wrapper' });
		this.includeRefsCheckbox = includeRefsWrapper.createEl('input', { type: 'checkbox' });
		includeRefsWrapper.createSpan({ text: 'Include Linked Pages', cls: 'chat-label' });

		// Google Search support
		const googleSearchWrapper = toolbarEl.createDiv({ cls: 'chat-control-item chat-checkbox-wrapper' });
		this.googleSearchCheckbox = googleSearchWrapper.createEl('input', { type: 'checkbox' });
		googleSearchWrapper.createSpan({ text: 'Internet Search*', cls: 'chat-label' });

		// Model Selector
		const modelWrapper = toolbarEl.createDiv({ cls: 'chat-control-item' });
		modelWrapper.createSpan({ text: 'Model: ', cls: 'chat-label' });
		this.modelDropdownEl = modelWrapper.createEl('select', { cls: 'chat-select' });
		this.modelDropdownEl.createEl('option', { value: 'gemini-3.8-flash', text: 'Gemini 3.8 Flash' });
		this.modelDropdownEl.createEl('option', { value: 'gemini-3.1-pro-preview', text: 'Gemini 3.1 Pro' });
		this.modelDropdownEl.createEl('option', { value: 'gemini-3.5-flash-lite', text: 'Gemini 3.5 Flash Lite' });
		this.modelDropdownEl.value = 'gemini-3.8-flash';

		const paidTierNoteEl = toolbarEl.createDiv({ cls: 'chat-paid-tier-note' });
		paidTierNoteEl.createSpan({ text: '*Requires Gemini API paid tier', cls: 'chat-note-text' });

		// Clear Chat Button
		this.clearBtnEl = toolbarEl.createEl('button', { text: 'Clear Chat', cls: 'chat-clear-btn chat-button' });
		this.clearBtnEl.addEventListener('click', () => this.clearChat());

		// Create Chat History container
		this.chatHistoryEl = container.createDiv({ cls: 'chat-history' });

		// Create Input container
		const inputContainer = container.createDiv({ cls: 'chat-input-container' });
		this.inputEl = inputContainer.createEl('textarea', {
			cls: 'chat-input',
			placeholder: 'Ask Gemini about your vault...'
		});

		this.inputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				void this.sendMessage();
			}
		});

		this.sendBtnEl = inputContainer.createEl('button', { text: 'Send', cls: 'chat-send-btn chat-button mod-cta' });
		this.sendBtnEl.addEventListener('click', () => void this.sendMessage());

		// Render initial empty / help message
		this.renderInitialMessage();
	}

	async onClose() {
		this.clearRenderComponents();
	}

	clearRenderComponents() {
		this.renderComponents.forEach(c => c.unload());
		this.renderComponents = [];
	}

	clearChat() {
		this.history = [];
		this.clearRenderComponents();
		this.chatHistoryEl.empty();
		this.renderInitialMessage();
	}

	renderInitialMessage() {
		const welcomeEl = this.chatHistoryEl.createDiv({ cls: 'chat-welcome-message' });
		welcomeEl.createEl('h3', { text: 'Ask Gemini Chat' });
		welcomeEl.createEl('p', { text: 'Ask questions using your vault, current folder, or current file as context.' });
		welcomeEl.createEl('p', { text: 'Choose context mode and model above.' });
	}

	async sendMessage() {
		if (this.isGenerating) return;
		const query = this.inputEl.value.trim();
		if (!query) return;

		this.inputEl.value = '';
		this.isGenerating = true;
		this.sendBtnEl.disabled = true;

		// Add User message
		this.addMessageToUI('user', query, query);

		// Get API Key
		const secretId = this.plugin.settings.geminiSecretId;
		const rawApiKey = secretId ? this.plugin.app.secretStorage.getSecret(secretId) : null;
		const apiKey = rawApiKey ? rawApiKey : null;

		if (!apiKey) {
			new Notice('Please select and set a valid Gemini API Key secret in the plugin settings.');
			this.addMessageToUI('model', 'Error: Gemini API Key secret is not configured in settings.', 'Error: Gemini API Key secret is not configured in settings.');
			this.isGenerating = false;
			this.sendBtnEl.disabled = false;
			return;
		}

		// Create placeholder response message in UI
		const placeholderMessageEl = this.addMessageToUI('model', 'Gathering context and thinking...', 'Gathering context and thinking...');
		placeholderMessageEl.addClass('chat-thinking');

		try {
			const contextMode = this.contextDropdownEl.value as 'file' | 'folder' | 'vault';
			const includeReferences = this.includeRefsCheckbox.checked;
			const enableGoogleSearch = this.googleSearchCheckbox.checked;

			// Format chat history to correct format for the REST API
			const contents = this.history.slice(0, -1).map(msg => ({
				role: msg.role,
				parts: [{ text: msg.text }]
			}));

			// Now call performGeminiChat
			const { answer, references } = await performGeminiChat(
				this.app,
				this.plugin,
				contents,
				query,
				contextMode,
				includeReferences,
				apiKey,
				this.modelDropdownEl.value,
				enableGoogleSearch
			);

			// Remove placeholder and add the real message
			placeholderMessageEl.remove();

			// Construct raw JSON format to store in history so model sees exact format in subsequent turns
			const rawModelResponse = JSON.stringify({
				answer,
				references: references.map(ref => ({
					path: ref.path,
					line: ref.lineNumber
				}))
			});

			this.addMessageToUI('model', rawModelResponse, answer, references);

		} catch (error) {
			console.error(error);
			placeholderMessageEl.remove();
			const errMsg = error instanceof Error ? error.message : String(error);
			this.addMessageToUI('model', errMsg, `Error: ${errMsg}`);
		} finally {
			this.isGenerating = false;
			this.sendBtnEl.disabled = false;
		}
	}

	addMessageToUI(role: 'user' | 'model', rawText: string, displayText: string, references?: ChatReference[]): HTMLElement {
		const messageEl = this.chatHistoryEl.createDiv({
			cls: `chat-message ${role === 'user' ? 'chat-message-user' : 'chat-message-model'}`
		});

		const avatarEl = messageEl.createDiv({ cls: 'chat-avatar' });
		avatarEl.setText(role === 'user' ? 'U' : 'AI');

		const contentContainer = messageEl.createDiv({ cls: 'chat-message-content' });

		if (role === 'user') {
			contentContainer.setText(displayText);
			this.history.push({ role, text: rawText, answer: displayText });
		} else {
			// Render markdown for bot response
			const comp = new Component();
			comp.load();
			this.renderComponents.push(comp);

			// Render the markdown content
			void MarkdownRenderer.render(this.app, displayText, contentContainer, '', comp);

			// If there are references, render them nicely
			if (references && references.length > 0) {
				const refsContainer = contentContainer.createDiv({ cls: 'chat-references-container' });
				refsContainer.createDiv({ text: 'Sources:', cls: 'chat-references-title' });
				const badgesWrapper = refsContainer.createDiv({ cls: 'chat-references-badges' });

				references.forEach(ref => {
					let badgeClass = 'badge-file';
					if (ref.type === 'line') {
						badgeClass = 'badge-line';
					}

					const badgeEl = badgesWrapper.createDiv({
						cls: `ultra-search-badge ${badgeClass} chat-ref-badge`,
					});

					const fileLabel = ref.lineNumber ? `${ref.title}:${ref.lineNumber}` : ref.title;
					badgeEl.setText(fileLabel);

					// Click to open
					badgeEl.addEventListener('click', (e) => {
						void this.navigateToResult(ref, e);
					});
				});
			}

			// Add to history
			this.history.push({ role, text: rawText, answer: displayText, references });
		}

		// Scroll to bottom
		this.chatHistoryEl.scrollTop = this.chatHistoryEl.scrollHeight;

		return messageEl;
	}

	async navigateToResult(result: ChatReference, evt: MouseEvent) {
		const leaf = this.app.workspace.getLeaf(evt.metaKey || evt.ctrlKey);
		const abstractFile = this.app.vault.getAbstractFileByPath(result.path);
		if (abstractFile instanceof TFile) {
			await leaf.openFile(abstractFile, { state: { mode: 'source' } });

			if (result.type === 'line' && result.lineNumber !== undefined) {
				const setEditorCursor = () => {
					const view = leaf.view;
					if (view instanceof MarkdownView) {
						const editor = view.editor;
						const pos = { line: result.lineNumber! - 1, ch: 0 };
						editor.setCursor(pos);
						editor.scrollIntoView({ from: pos, to: pos }, true);
						editor.focus();
						return true;
					}
					return false;
				};

				if (!setEditorCursor()) {
					window.setTimeout(() => {
						setEditorCursor();
					}, 50);
				}
			}
		}
	}
}
