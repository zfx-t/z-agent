import type { TuiHeaderState, TuiInspectorState, TuiToolSnapshot, TuiTranscriptEntry } from "./model.ts";

export interface TuiPickerState {
	title: string;
	items: string[];
	index: number;
	query: string;
}

export interface TuiFrameState {
	status: string;
	header?: TuiHeaderState;
	transcript: Array<TuiTranscriptEntry | string>;
	editorLines: string[];
	confirm?: string;
	picker?: TuiPickerState;
	inspector?: TuiInspectorState;
	streaming: boolean;
	/** Set false for a deliberately monochrome terminal. */
	colors?: boolean;
}

type Tone = "accent" | "dim" | "error" | "info" | "muted" | "success" | "strong" | "warning";

const ANSI: Record<Tone, string> = {
	accent: "\x1b[38;5;45m",
	dim: "\x1b[2m",
	error: "\x1b[38;5;203m",
	info: "\x1b[38;5;111m",
	muted: "\x1b[38;5;245m",
	success: "\x1b[38;5;78m",
	strong: "\x1b[1m",
	warning: "\x1b[38;5;221m",
};
const RESET = "\x1b[0m";
const ESC = "\u001b";
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");

/** Render a stable terminal frame with a live editor and optional inspector. */
export function renderFrame(state: TuiFrameState, width: number, height: number): string[] {
	const safeWidth = Math.max(20, width);
	const safeHeight = Math.max(7, height);
	const paint = (tone: Tone, text: string): string => color(state.colors !== false, tone, text);
	const header = renderHeader(state, safeWidth, paint);
	const divider = paint("dim", "-".repeat(safeWidth));
	const footer = footerLines(state, safeWidth, paint);
	const reserved = 1 + 1 + footer.length;
	const bodyHeight = Math.max(1, safeHeight - reserved);
	let body: string[];
	if (state.picker) {
		body = fitLines(pickerLines(state.picker, safeWidth, paint).slice(-bodyHeight), bodyHeight);
	} else if (state.inspector && safeWidth >= 110) {
		body = splitBody(state.transcript, state.inspector, safeWidth, bodyHeight, paint);
	} else {
		body = fitLines(transcriptLines(state.transcript, safeWidth, paint).slice(-bodyHeight), bodyHeight);
	}
	return [header, divider, ...body, ...footer];
}

function renderHeader(state: TuiFrameState, width: number, paint: (tone: Tone, text: string) => string): string {
	if (!state.header) {
		const fallback = `${paint("strong", " Z AGENT ")}${paint("dim", " | ")}${clean(state.status)}`;
		return clip(
			`${fallback}${paint(state.streaming ? "accent" : "success", state.streaming ? " RUNNING " : " READY ")}`,
			width,
		);
	}
	const statusTone: Tone = state.streaming ? "accent" : "success";
	const fields = [
		paint("strong", " Z AGENT "),
		paint("muted", `cwd: ${clean(state.header.cwd)}`),
		paint("muted", `model: ${clean(state.header.model)}`),
		paint(statusTone, `status: ${state.streaming ? "RUNNING" : "READY"}`),
		paint("muted", `session: ${clean(state.header.session)}`),
	];
	return clip(fields.join("  "), width);
}

function footerLines(state: TuiFrameState, width: number, paint: (tone: Tone, text: string) => string): string[] {
	if (state.picker) {
		return [paint("muted", clip(pickerHint(width), width))];
	}
	const lines: string[] = [];
	if (state.confirm) {
		lines.push(paint("warning", clip(` CONFIRM ${clean(state.confirm)}`, width)));
	}
	const border = paint("accent", `+${"-".repeat(Math.max(0, width - 2))}+`);
	lines.push(border);
	const editor = state.editorLines.length > 0 ? state.editorLines : ["|"];
	const editorRows = editor.length < 2 ? [...editor, ""] : editor;
	const contentWidth = Math.max(1, width - 4);
	const editorContent = editorRows.flatMap((row) => wrap(clean(row), Math.max(1, contentWidth - 2))).slice(-3);
	for (const [index, line] of editorContent.entries()) {
		const marker = index === 0 ? paint("accent", "> ") : "  ";
		const content = `${marker}${clip(line, Math.max(1, contentWidth - visibleWidth(marker)))}`;
		lines.push(`| ${padTo(content, contentWidth)} |`);
	}
	lines.push(border);
	lines.push(paint("muted", clip(inputHint(width, state.streaming), width)));
	return lines;
}

function inputHint(width: number, streaming: boolean): string {
	const interrupt = streaming ? "Ctrl+C interrupt" : "Ctrl+C exit";
	if (width >= 72) {
		return ` Enter send  Shift+Enter newline  ${interrupt}`;
	}
	if (width >= 54) {
		return ` Enter send  Shift+Enter newline  ${interrupt}`;
	}
	if (width >= 34) {
		return ` Enter send  ${interrupt}`;
	}
	return " Enter send  Shift+Enter newline";
}

function pickerHint(width: number): string {
	return width >= 46
		? " Up/Down select  Enter confirm  1-9 jump  Esc cancel"
		: " Up/Down select  Enter confirm  Esc cancel";
}

function pickerLines(picker: TuiPickerState, width: number, paint: (tone: Tone, text: string) => string): string[] {
	const lines = [paint("strong", ` ${clean(picker.title)}`), paint("dim", ` Search: ${clean(picker.query)}|`)];
	if (picker.items.length === 0) {
		lines.push(paint("muted", " No matches"));
		return lines;
	}
	for (let index = 0; index < picker.items.length; index += 1) {
		const selected = index === picker.index;
		const prefix = selected ? ">" : " ";
		const text = ` ${prefix} ${index + 1}. ${clean(picker.items[index] ?? "")}`;
		lines.push(clip(selected ? paint("accent", text) : text, width));
	}
	return lines;
}

function transcriptLines(
	entries: Array<TuiTranscriptEntry | string>,
	width: number,
	paint: (tone: Tone, text: string) => string,
): string[] {
	const rendered: string[] = [];
	for (const entry of entries) {
		rendered.push(...renderTranscriptEntry(entry, width, paint));
	}
	return rendered;
}

function renderTranscriptEntry(
	entry: TuiTranscriptEntry | string,
	width: number,
	paint: (tone: Tone, text: string) => string,
): string[] {
	const presentation = transcriptPresentation(typeof entry === "string" ? legacyEntry(entry) : entry);
	const timestamp =
		typeof entry === "string" || entry.createdAt === undefined ? "" : `${formatTime(entry.createdAt)} `;
	const prefix = ` ${timestamp}${presentation.label} `;
	const continuation = " ".repeat(visibleWidth(prefix));
	const bodyWidth = Math.max(1, width - visibleWidth(prefix));
	const wrapped = wrap(clean(presentation.text), bodyWidth);
	return wrapped.map((part, index) => {
		const marker = index === 0 ? prefix : continuation;
		return `${paint(presentation.tone, marker)}${part}`;
	});
}

function formatTime(timestamp: number): string {
	const date = new Date(timestamp);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(
		date.getSeconds(),
	).padStart(2, "0")}`;
}

function legacyEntry(text: string): TuiTranscriptEntry {
	return { id: "legacy", kind: "info", text };
}

function transcriptPresentation(entry: TuiTranscriptEntry): { label: string; text: string; tone: Tone } {
	if (entry.kind === "user") {
		return { label: "YOU", text: entry.text, tone: "accent" };
	}
	if (entry.kind === "assistant") {
		return { label: "AI ", text: entry.text, tone: "strong" };
	}
	if (entry.kind === "thinking") {
		return {
			label: entry.hidden ? "THINK*" : "THINK",
			text: entry.hidden ? `${entry.text} (hidden)` : entry.text,
			tone: "muted",
		};
	}
	if (entry.kind === "tool" && entry.tool) {
		const marker = toolStateLabel(entry.tool);
		const text = `${entry.tool.toolName} ${entry.tool.argsText}${marker ? ` ${marker}` : ""}`;
		const tone: Tone = entry.tool.state === "error" ? "error" : entry.tool.state === "success" ? "success" : "info";
		return { label: "TOOL", text, tone };
	}
	if (entry.kind === "warning") {
		return { label: "WARN", text: entry.text, tone: "warning" };
	}
	if (entry.kind === "error") {
		return { label: "ERROR", text: entry.text, tone: "error" };
	}
	return { label: "INFO", text: entry.text, tone: "muted" };
}

function toolStateLabel(tool: TuiToolSnapshot): string {
	if (tool.state === "running") {
		return "RUNNING";
	}
	return tool.state === "success" ? "DONE" : "FAIL";
}

function splitBody(
	transcript: Array<TuiTranscriptEntry | string>,
	inspector: TuiInspectorState,
	width: number,
	height: number,
	paint: (tone: Tone, text: string) => string,
): string[] {
	const available = width - 3;
	const leftWidth = Math.max(40, Math.floor(available * 0.64));
	const rightWidth = Math.max(38, available - leftWidth);
	const transcriptLinesForPane = transcriptLines(transcript, leftWidth, paint);
	const transcriptBody = fitLines(transcriptLinesForPane.slice(-height), height).map((line) => padTo(line, leftWidth));
	const inspectorBody = inspectorLines(inspector, rightWidth, paint).slice(0, height);
	while (inspectorBody.length < height) {
		inspectorBody.push("");
	}
	return transcriptBody.map(
		(line, index) => `${line} ${paint("dim", "|")} ${padTo(inspectorBody[index] ?? "", rightWidth)}`,
	);
}

function inspectorLines(
	inspector: TuiInspectorState,
	width: number,
	paint: (tone: Tone, text: string) => string,
): string[] {
	const tool = inspector.tool;
	const statusTone: Tone = tool.state === "running" ? "accent" : tool.state === "success" ? "success" : "error";
	const lines = [
		paint("strong", " TOOL DETAILS"),
		paint("dim", " ------------------------------"),
		paint("info", ` tool: ${tool.toolName}`),
		paint("muted", ` status: ${toolStateLabel(tool)}`),
		paint("muted", ` call: ${tool.toolCallId}`),
		paint(statusTone, ` state: ${tool.state}`),
		paint("muted", ` args: ${tool.argsText}`),
	];
	if (tool.durationMs !== undefined) {
		lines.push(paint("muted", ` duration: ${tool.durationMs} ms`));
	}
	if (tool.outputText) {
		lines.push(paint("strong", " output:"));
		lines.push(...tool.outputText.split("\n").map((line) => paint("muted", ` | ${line}`)));
	}
	if (tool.detailsText) {
		lines.push(paint("strong", " details:"));
		lines.push(...tool.detailsText.split("\n").map((line) => paint("muted", ` | ${line}`)));
	}
	return lines.map((line) => clip(line, width));
}

function fitLines(lines: string[], height: number): string[] {
	const result = lines.slice(-height);
	while (result.length < height) {
		result.unshift("");
	}
	return result;
}

function padTo(text: string, width: number): string {
	const clipped = clip(text, width);
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function color(enabled: boolean, tone: Tone, text: string): string {
	return enabled ? `${ANSI[tone]}${text}${RESET}` : text;
}

function clean(text: string): string {
	return removeControls(text.replace(ANSI_PATTERN, "")).replace(/\t/g, "  ");
}

function removeControls(text: string): string {
	return Array.from(text)
		.filter((char) => {
			const code = char.codePointAt(0) ?? 0;
			return code === 0x0a || code === 0x09 || (code >= 0x20 && code !== 0x7f);
		})
		.join("");
}

function wrap(text: string, width: number): string[] {
	const parts = text.split("\n");
	const lines: string[] = [];
	for (const part of parts) {
		if (part.length === 0) {
			lines.push("");
			continue;
		}
		let current = "";
		let currentWidth = 0;
		for (const char of Array.from(part)) {
			const charWidth = cellWidth(char);
			if (currentWidth > 0 && currentWidth + charWidth > width) {
				lines.push(current);
				current = "";
				currentWidth = 0;
			}
			current += char;
			currentWidth += charWidth;
		}
		lines.push(current);
	}
	return lines.length > 0 ? lines : [""];
}

function clip(text: string, width: number): string {
	if (visibleWidth(text) <= width) {
		return text;
	}
	const plain = clean(text);
	if (width <= 3) {
		return wrap(plain, Math.max(1, width))[0] ?? "";
	}
	const clipped = wrap(plain, Math.max(1, width - 3))[0] ?? "";
	return `${clipped}...`;
}

function visibleWidth(text: string): number {
	return Array.from(text.replace(ANSI_PATTERN, "")).reduce((total, char) => total + cellWidth(char), 0);
}

function cellWidth(char: string): number {
	const code = char.codePointAt(0) ?? 0;
	if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || (code >= 0x300 && code <= 0x36f)) {
		return 0;
	}
	return code >= 0x1100 && (code <= 0x115f || code >= 0x2e80) ? 2 : 1;
}
