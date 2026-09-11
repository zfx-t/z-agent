import type { TuiInspectorView, TuiToolDetail, TuiToolRenderer, TuiToolSnapshot } from "./model.ts";

export interface TuiSummaryRow {
	label: string;
	value: string;
}

/** Returns only views backed by data available in the terminal view model. */
export function availableInspectorViews(tool: TuiToolSnapshot, renderer?: TuiToolRenderer): TuiInspectorView[] {
	const custom = safeRender(tool, renderer);
	const views: TuiInspectorView[] = ["summary"];
	if ((custom?.output && custom.output.length > 0) || (tool.outputText && tool.outputText.length > 0)) {
		views.push("output");
	}
	if ((custom?.diff && custom.diff.length > 0) || diffLines(tool).length > 0) {
		views.push("diff");
	}
	return views;
}

/**
 * One-line semantic summary of a tool invocation for the transcript row.
 * Falls back to the pre-compact JSON args for unknown tools.
 */
export function toolTargetSummary(tool: TuiToolSnapshot): string {
	const input = asRecord(tool.input);
	if (!input) {
		return tool.argsText;
	}
	const path = stringField(input, "path");
	switch (tool.toolName) {
		case "bash": {
			const command = stringField(input, "command");
			return command ? `$ ${command}` : tool.argsText;
		}
		case "edit": {
			const edits = Array.isArray(input.edits) ? input.edits.length : 0;
			const count = edits > 0 ? ` · ${edits} edit${edits === 1 ? "" : "s"}` : "";
			return `${path ?? tool.argsText}${count}`;
		}
		case "write":
		case "read":
		case "ls":
			return path ?? tool.argsText;
		case "grep": {
			const pattern = stringField(input, "pattern");
			if (!pattern) {
				return tool.argsText;
			}
			return path ? `/${pattern}/ in ${path}` : `/${pattern}/`;
		}
		case "find": {
			const pattern = stringField(input, "pattern");
			if (!pattern) {
				return tool.argsText;
			}
			return path ? `${pattern} in ${path}` : pattern;
		}
		default:
			return tool.argsText;
	}
}

/** Compact metadata for the default inline inspector page. */
export function summaryRows(tool: TuiToolSnapshot): TuiSummaryRow[] {
	const input = asRecord(tool.input);
	const rows: TuiSummaryRow[] = [
		{ label: "tool", value: tool.toolName },
		{ label: "state", value: tool.state },
	];
	const target = stringField(input, "path") ?? stringField(input, "command") ?? stringField(input, "pattern");
	if (target) {
		rows.push({ label: tool.toolName === "bash" ? "command" : "target", value: target });
	}
	if (tool.durationMs !== undefined) {
		rows.push({ label: "duration", value: `${tool.durationMs} ms` });
	}
	const details = asRecord(parseDetails(tool.detailsText));
	const exitCode = details ? details.exitCode : undefined;
	if (typeof exitCode === "number" || exitCode === null) {
		rows.push({ label: "exit", value: exitCode === null ? "signal" : String(exitCode) });
	}
	return rows;
}

/** A bounded renderer can use these source lines without inventing a patch. */
export function detailLines(tool: TuiToolSnapshot, view: TuiInspectorView, renderer?: TuiToolRenderer): string[] {
	const custom = safeRender(tool, renderer);
	if (view === "summary") {
		return custom?.summary && custom.summary.length > 0
			? custom.summary
			: summaryRows(tool).map((row) => `${row.label}: ${row.value}`);
	}
	if (view === "output") {
		if (custom?.output && custom.output.length > 0) {
			return custom.output;
		}
		return tool.outputText?.split("\n") ?? ["No output available."];
	}
	if (custom?.diff && custom.diff.length > 0) {
		return custom.diff;
	}
	const lines = diffLines(tool);
	return lines.length > 0 ? lines : ["No diff preview available."];
}

function safeRender(tool: TuiToolSnapshot, renderer?: TuiToolRenderer): TuiToolDetail | undefined {
	if (!renderer) {
		return undefined;
	}
	try {
		return renderer(tool);
	} catch {
		return undefined;
	}
}

/** First meaningful output line plus a remaining-line count for the ⎿ preview row. */
export function previewLine(tool: TuiToolSnapshot): { text: string; more: number } | undefined {
	const output = tool.outputText;
	if (!output || output.trim().length === 0) {
		return undefined;
	}
	const lines = output.split("\n");
	if (tool.state === "running") {
		const last = lines.filter((line) => line.trim().length > 0).at(-1);
		return last ? { text: last, more: 0 } : undefined;
	}
	const first = lines.find((line) => line.trim().length > 0) ?? lines[0] ?? "";
	const more = Math.max(0, lines.length - lines.indexOf(first) - 1);
	return { text: first, more };
}

function diffLines(tool: TuiToolSnapshot): string[] {
	const input = asRecord(tool.input);
	if (!input) {
		return [];
	}
	if (tool.toolName === "edit") {
		const edits = input.edits;
		if (!Array.isArray(edits)) {
			return [];
		}
		return edits.flatMap((edit) => {
			const record = asRecord(edit);
			const oldText = stringField(record, "oldText");
			const newText = stringField(record, "newText");
			if (oldText === undefined || newText === undefined) {
				return [];
			}
			return [...prefixLines("- ", oldText), ...prefixLines("+ ", newText)];
		});
	}
	if (tool.toolName === "write") {
		const content = stringField(input, "content");
		return content === undefined ? [] : prefixLines("+ ", content);
	}
	return [];
}

function prefixLines(prefix: string, text: string): string[] {
	return text.split("\n").map((line) => `${prefix}${line}`);
}

function parseDetails(text: string | undefined): unknown {
	if (!text) {
		return undefined;
	}
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === "string" ? value : undefined;
}
