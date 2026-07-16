export interface ChatReference {
	type: 'line' | 'file';
	path: string;
	title: string;
	lineNumber?: number;
}
