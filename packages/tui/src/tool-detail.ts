import type { TuiInspectorView, TuiToolSnapshot } from "./model.ts";

export interface TuiSummaryRow {
	label: string;
	value: string;
}

/** Returns only views backed by data available in the terminal view model. */
export function availableInspectorViews(tool: TuiToolSnapshot): TuiInspectorView[] {
	const views: TuiInspectorView[] = ["summary"];
	if (tool.outputText && tool.outputText.length > 0) {
		views.push("output");
	}
	if (diffLines(tool).length > 0) {
		views.push("diff");
	}
	return views;
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
export function detailLines(tool: TuiToolSnapshot, view: TuiInspectorView): string[] {
	if (view === "summary") {
		return summaryRows(tool).map((row) => `${row.label}: ${row.value}`);
	}
	if (view === "output") {
		return tool.outputText?.split("\n") ?? ["No output available."];
	}
	const lines = diffLines(tool);
	return lines.length > 0 ? lines : ["No diff preview available."];
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
