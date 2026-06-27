import type { TAbstractFile } from 'obsidian';

export interface SearchResult {
	type: 'line' | 'file';
	file: TAbstractFile;
	lineNumber?: number;
	text: string;
	score: number;
}

// Helper to determine allowed typos based on word length
export function getMaxTypos(len: number): number {
	if (len >= 3 && len <= 5) return 1;
	if (len >= 6) return 2;
	return 0;
}

// Helper to check if terms appear in order within the text to apply a bonus
export function getInOrderBonus(textLower: string, terms: string[]): number {
	if (terms.length <= 1) return 0;
	let lastIdx = -1;
	for (const term of terms) {
		const idx = textLower.indexOf(term);
		if (idx !== -1 && idx > lastIdx) {
			lastIdx = idx;
		} else {
			return 0;
		}
	}
	return 20;
}

// Prefix Levenshtein Distance for typo-tolerant matching
export function minPrefixLevenshteinDistance(word: string, query: string): number {
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
export function fuzzyMatch(textLower: string, queryLower: string): { matches: boolean; score: number } {
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

	const maxTypos = getMaxTypos(qLen);

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
