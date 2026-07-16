import { App, TFile, requestUrl, Notice } from 'obsidian';
import type UltraSearchPlugin from './main'; // We'll need access to the plugin for index/exclusion
import type { ChatReference } from './types';

export async function gatherContext(
	app: App,
	plugin: UltraSearchPlugin,
	mode: 'file' | 'folder' | 'vault',
	includeReferences: boolean
): Promise<string> {
	const activeFile = app.workspace.getActiveFile();

	let filesToProcess: TFile[] = [];
	const allFiles = app.vault.getMarkdownFiles();

	if (mode === 'file') {
		if (activeFile) {
			filesToProcess.push(activeFile);
		} else {
			new Notice('No active file for context. Falling back to vault.');
			filesToProcess = allFiles;
		}
	} else if (mode === 'folder') {
		if (activeFile && activeFile.parent) {
			filesToProcess = allFiles.filter(f => f.parent?.path === activeFile.parent?.path);
		} else {
			new Notice('No active folder for context. Falling back to vault.');
			filesToProcess = allFiles;
		}
	} else {
		filesToProcess = allFiles;
	}

	if (includeReferences) {
		const linkedFiles = new Set<TFile>();
		for (const file of filesToProcess) {
			const cache = app.metadataCache.getFileCache(file);
			if (cache && cache.links) {
				for (const link of cache.links) {
					const targetFile = app.metadataCache.getFirstLinkpathDest(link.link, file.path);
					if (targetFile instanceof TFile) {
						linkedFiles.add(targetFile);
					}
				}
			}
		}

		for (const linked of linkedFiles) {
			if (!filesToProcess.includes(linked)) {
				filesToProcess.push(linked);
			}
		}
	}

	let contextStr = '';
	for (const file of filesToProcess) {
		if (!file) continue;
		if (plugin.isFolderExcluded(file.path, plugin.settings.excludeFolders)) continue;

		try {
			const content = await app.vault.cachedRead(file);
			contextStr += `\n--- File: ${file.path} ---\n`;
			const lines = content.split(/\r?\n/);
			for (let i = 0; i < lines.length; i++) {
				contextStr += `${i + 1}: ${lines[i]}\n`;
			}
		} catch (e) {
			console.error(`Failed to read file for context: ${file.path}`, e);
		}
	}
	return contextStr;
}

const RESPONSE_SCHEMA = {
	type: 'object',
	properties: {
		answer: {
			type: 'string',
			description: 'Your detailed markdown answer here with explanations'
		},
		references: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description: 'relative file path of the referenced markdown file (e.g. folder/note.md)'
					},
					line: {
						type: 'integer',
						description: 'line number of the referenced text inside the markdown file (1-indexed)'
					}
				},
				required: ['path']
			},
			description: 'List of referenced notes and lines'
		}
	},
	required: ['answer', 'references']
};



export async function callGeminiChatAPI(
	contents: { role: 'user' | 'model'; parts: { text: string }[] }[],
	systemInstruction: string,
	apiKey: string,
	model: string,
	enableGoogleSearch?: boolean
): Promise<string> {
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

	const body: {
		contents: typeof contents;
		systemInstruction: {
			parts: { text: string }[];
		};
		generationConfig: {
			responseMimeType: string;
			responseSchema: typeof RESPONSE_SCHEMA;
		};
		tools?: {
			google_search: Record<string, unknown>;
		}[];
	} = {
		contents,
		systemInstruction: {
			parts: [{
				text: systemInstruction
			}]
		},
		generationConfig: {
			responseMimeType: "application/json",
			responseSchema: RESPONSE_SCHEMA
		}
	};

	if (enableGoogleSearch) {
		body.tools = [
			{
				google_search: {}
			}
		];
	}

	const response = await requestUrl({
		url,
		method: 'POST',
		headers: {
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(body),
		throw: false
	});

	if (response.status !== 200) {
		let errorMsg = response.text;
		try {
			const errorJson = response.json as { error?: { message?: string } };
			if (errorJson?.error?.message) {
				errorMsg = errorJson.error.message;
			}
		} catch {
			// Ignore JSON parse errors
		}
		throw new Error(`API Error (${response.status}): ${errorMsg}`);
	}

	const data = response.json as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
	if (data?.candidates?.[0]?.content?.parts?.[0]?.text) {
		return data.candidates[0].content.parts[0].text;
	}

	return 'No response from Gemini.';
}

export async function performGeminiChat(
	app: App,
	plugin: UltraSearchPlugin,
	history: { role: 'user' | 'model'; parts: { text: string }[] }[],
	query: string,
	contextMode: 'file' | 'folder' | 'vault',
	includeReferences: boolean,
	apiKey: string,
	model: string,
	enableGoogleSearch?: boolean
): Promise<{ answer: string; references: ChatReference[] }> {
	const contextText = await gatherContext(app, plugin, contextMode, includeReferences);

	if (contextText.length > 500000) {
		new Notice('Warning: Context is very large. This may exceed API token limits or take a long time.');
	}

	const systemInstruction = `You are a helpful assistant. Answer the user's question using the provided context.`;

	const queryWithContext = `Context:
${contextText}

Question: ${query}`;

	const contents = [
		...history,
		{
			role: 'user' as const,
			parts: [{ text: queryWithContext }]
		}
	];

	const response = await callGeminiChatAPI(contents, systemInstruction, apiKey, model, enableGoogleSearch);
	let responseObj: { answer?: string, references?: { path?: string, line?: number }[] } | null = null;
	try {
		const cleanResponse = response.replace(/^```json\s*/, '').replace(/\s*```$/, '');
		responseObj = JSON.parse(cleanResponse) as { answer?: string, references?: { path?: string, line?: number }[] };
	} catch {
		return { answer: response, references: [] };
	}

	const answer = responseObj.answer || '';
	const references: ChatReference[] = [];
	const seenRefs = new Set<string>();

	if (responseObj.references && Array.isArray(responseObj.references)) {
		for (const ref of responseObj.references) {
			if (!ref.path) continue;

			const refKey = `${ref.path}::${ref.line !== undefined ? ref.line : ''}`;
			if (seenRefs.has(refKey)) continue;
			seenRefs.add(refKey);

			const abstractFile = app.vault.getAbstractFileByPath(ref.path);
			if (abstractFile instanceof TFile) {
				let textVal = abstractFile.name;

				if (ref.line !== undefined) {
					try {
						const content = await app.vault.cachedRead(abstractFile);
						const lines = content.split(/\r?\n/);
						if (ref.line > 0 && ref.line <= lines.length) {
							textVal = lines[ref.line - 1]!.trim();
							if (!textVal) textVal = `[Empty line ${ref.line}]`;
						}
					} catch {
						// ignore
					}
				}

				references.push({
					type: ref.line !== undefined ? 'line' : 'file',
					path: ref.path,
					title: abstractFile.name,
					lineNumber: ref.line
				});
			}
		}
	}

	return { answer, references };
}

