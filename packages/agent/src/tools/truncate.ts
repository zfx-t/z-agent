/**
 * Head/tail truncation for tool outputs. Whichever of line or byte limit hits first wins.
 * Never returns a partial line.
 */

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;

export interface TruncationOptions {
	maxLines?: number;
	maxBytes?: number;
}

export interface TruncationResult {
	content: string;
	truncated: boolean;
	truncatedBy: "lines" | "bytes" | null;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	maxLines: number;
	maxBytes: number;
}

function splitLinesForCounting(content: string): string[] {
	if (content.length === 0) {
		return [];
	}
	const lines = content.split("\n");
	if (content.endsWith("\n")) {
		lines.pop();
	}
	return lines;
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes}B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)}KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function emptyResult(
	content: string,
	totalLines: number,
	totalBytes: number,
	maxLines: number,
	maxBytes: number,
	truncatedBy: TruncationResult["truncatedBy"],
): TruncationResult {
	const outputBytes = Buffer.byteLength(content, "utf-8");
	const outputLines = splitLinesForCounting(content).length;
	return {
		content,
		truncated: truncatedBy !== null,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines,
		outputBytes,
		maxLines,
		maxBytes,
	};
}

export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const totalBytes = Buffer.byteLength(content, "utf-8");
	const lines = splitLinesForCounting(content);
	const totalLines = lines.length;

	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return emptyResult(content, totalLines, totalBytes, maxLines, maxBytes, null);
	}

	const firstLineBytes = lines.length > 0 ? Buffer.byteLength(lines[0], "utf-8") : 0;
	if (firstLineBytes > maxBytes) {
		return emptyResult("", totalLines, totalBytes, maxLines, maxBytes, "bytes");
	}

	const kept: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";

	for (let i = 0; i < lines.length && i < maxLines; i++) {
		const line = lines[i];
		const lineBytes = Buffer.byteLength(line, "utf-8") + (i > 0 ? 1 : 0);
		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}
		kept.push(line);
		outputBytesCount += lineBytes;
	}

	if (kept.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	return emptyResult(kept.join("\n"), totalLines, totalBytes, maxLines, maxBytes, truncatedBy);
}

export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const totalBytes = Buffer.byteLength(content, "utf-8");
	const lines = splitLinesForCounting(content);
	const totalLines = lines.length;

	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return emptyResult(content, totalLines, totalBytes, maxLines, maxBytes, null);
	}

	const kept: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";

	for (let i = lines.length - 1; i >= 0 && kept.length < maxLines; i--) {
		const line = lines[i];
		const lineBytes = Buffer.byteLength(line, "utf-8") + (kept.length > 0 ? 1 : 0);
		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}
		kept.unshift(line);
		outputBytesCount += lineBytes;
	}

	if (kept.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	return emptyResult(kept.join("\n"), totalLines, totalBytes, maxLines, maxBytes, truncatedBy);
}

export function truncationNotice(result: TruncationResult, kind: "head" | "tail"): string | undefined {
	if (!result.truncated) {
		return undefined;
	}
	const shown = kind === "tail" ? "last " : "";
	if (result.truncatedBy === "lines") {
		return `[Truncated: showing ${shown}${result.outputLines} of ${result.totalLines} lines]`;
	}
	return `[Truncated: showing ${shown}${result.outputLines} lines (${formatSize(result.maxBytes)} limit)]`;
}
