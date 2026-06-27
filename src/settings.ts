export interface UltraSearchSettings {
	maxResults: number;
	minQueryLength: number;
	excludeFolders: string;
	geminiModel: string;
	geminiSecretId: string;
}

export const DEFAULT_SETTINGS: UltraSearchSettings = {
	maxResults: 10,
	minQueryLength: 1,
	excludeFolders: '',
	geminiModel: 'gemini-3.5-flash',
	geminiSecretId: ''
};
