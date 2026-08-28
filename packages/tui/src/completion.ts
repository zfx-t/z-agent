import type { TuiCompletionCandidate } from "./model.ts";

export const DEFAULT_COMPLETION_ROWS = 6;

export interface CompletionTokenRange {
	query: string;
	start: number;
	end: number;
}

/** Find the first slash-prefixed token without consuming its arguments. */
export function slashCompletionToken(value: string, cursorOffset = value.length): CompletionTokenRange | undefined {
	if (value.includes("\n") || cursorOffset < 0 || cursorOffset > value.length) {
		return undefined;
	}
	const start = value.search(/\S/u);
	if (start < 0 || value[start] !== "/") {
		return undefined;
	}
	const separator = value.slice(start).search(/\s/u);
	const end = separator < 0 ? value.length : start + separator;
	if (cursorOffset < start) {
		return undefined;
	}
	return { query: value.slice(start, Math.min(cursorOffset, end)), start, end };
}

/** Rank slash tokens deterministically without invoking their commands. */
export function rankSlashCompletions(
	candidates: readonly TuiCompletionCandidate[],
	query: string,
	maxItems = DEFAULT_COMPLETION_ROWS,
): TuiCompletionCandidate[] {
	const limit = Number.isFinite(maxItems) ? Math.max(0, Math.trunc(maxItems)) : DEFAULT_COMPLETION_ROWS;
	return candidates
		.map((candidate, order) => ({ candidate, order, rank: matchRank(candidate.token, query) }))
		.filter(
			(entry): entry is { candidate: TuiCompletionCandidate; order: number; rank: number } =>
				entry.rank !== undefined,
		)
		.sort((left, right) => {
			return (
				left.rank - right.rank ||
				kindRank(left.candidate.kind) - kindRank(right.candidate.kind) ||
				compareText(left.candidate.token.toLowerCase(), right.candidate.token.toLowerCase()) ||
				compareText(left.candidate.token, right.candidate.token) ||
				left.order - right.order
			);
		})
		.slice(0, limit)
		.map((entry) => entry.candidate);
}

function matchRank(token: string, query: string): number | undefined {
	if (token === query) {
		return 0;
	}
	const normalizedToken = token.toLowerCase();
	const normalizedQuery = query.toLowerCase();
	if (normalizedToken.startsWith(normalizedQuery)) {
		return 1;
	}
	if (normalizedToken.includes(normalizedQuery)) {
		return 2;
	}
	return isOrderedSubsequence(normalizedToken, normalizedQuery) ? 3 : undefined;
}

function isOrderedSubsequence(value: string, query: string): boolean {
	let offset = 0;
	for (const character of query) {
		const match = value.indexOf(character, offset);
		if (match < 0) {
			return false;
		}
		offset = match + character.length;
	}
	return true;
}

function kindRank(kind: TuiCompletionCandidate["kind"]): number {
	return kind === "command" ? 0 : 1;
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
