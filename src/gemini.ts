import { App, TFile, MarkdownView, requestUrl, Notice } from 'obsidian';
import type { SearchResult } from './search';
import type UltraSearchPlugin from './main'; // We'll need access to the plugin for index/exclusion

export async function gatherContext(
	app: App,
	plugin: UltraSearchPlugin,
	mode: 'file' | 'folder' | 'vault',
	includeReferences: boolean
): Promise<string> {
	const activeLeaf = app.workspace.getLeaf(false);
	const activeFile = activeLeaf.view instanceof MarkdownView ? activeLeaf.view.file : null;

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

export async function callGeminiAPI(prompt: string, apiKey: string, model: string): Promise<string> {
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

	const response = await requestUrl({
		url,
		method: 'POST',
		headers: {
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			contents: [{
				parts: [{
					text: prompt
				}]
			}],
			generationConfig: {
				responseMimeType: "application/json"
			}
		}),
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

export async function performGeminiSearch(
	app: App,
	plugin: UltraSearchPlugin,
	query: string,
	contextMode: 'file' | 'folder' | 'vault',
	includeReferences: boolean,
	apiKey: string,
	model: string
): Promise<{ answer: string; references: SearchResult[] }> {
	const contextText = await gatherContext(app, plugin, contextMode, includeReferences);

	if (contextText.length > 500000) {
		new Notice('Warning: Context is very large. This may exceed API token limits or take a long time.');
	}

	const prompt = `You are a helpful assistant. Answer the user's question using the provided context.
You MUST reply strictly in JSON format matching this schema exactly:
{
  "answer": "Your detailed markdown answer here with explanations",
  "references": [
    { "path": "file/path.md", "line": 123 }
  ]
}

Context:
${contextText}

Question: ${query}`;

	const response = await callGeminiAPI(prompt, apiKey, model);
	let responseObj: { answer?: string, references?: { path?: string, line?: number }[] } | null = null;
	try {
		// Some models might wrap JSON in markdown blocks
		const cleanResponse = response.replace(/^```json\s*/, '').replace(/\s*```$/, '');
		responseObj = JSON.parse(cleanResponse) as { answer?: string, references?: { path?: string, line?: number }[] };
	} catch {
		// Fallback to rendering as markdown if it fails
		return { answer: response, references: [] };
	}

	const answer = responseObj.answer || '';
	const references: SearchResult[] = [];
	const seenRefs = new Set<string>();

	if (responseObj.references && Array.isArray(responseObj.references)) {
		for (const ref of responseObj.references) {
			if (!ref.path) continue;

			const refKey = `${ref.path}::${ref.line !== undefined ? ref.line : ''}`;
			if (seenRefs.has(refKey)) continue;
			seenRefs.add(refKey);

			const abstractFile = app.vault.getAbstractFileByPath(ref.path);
			if (abstractFile instanceof TFile) {
				let text = abstractFile.name;

				if (ref.line !== undefined) {
					try {
						const content = await app.vault.cachedRead(abstractFile);
						const lines = content.split(/\r?\n/);
						if (ref.line > 0 && ref.line <= lines.length) {
							text = lines[ref.line - 1]!.trim();
							// Fallback if the line is completely empty
							if (!text) text = `[Empty line ${ref.line}]`;
						}
					} catch {
						// ignore
					}
				}

				references.push({
					type: ref.line !== undefined ? 'line' : 'file',
					file: abstractFile,
					lineNumber: ref.line,
					text: text,
					score: 0
				});
			}
		}
	}

	return { answer, references };
}
