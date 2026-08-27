import type { TuiFocus, TuiHeaderState, TuiInspectorState, TuiToolSnapshot, TuiTranscriptEntry } from "./model.ts";
import { availableInspectorViews, detailLines } from "./tool-detail.ts";

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
	focus?: TuiFocus;
	selectedToolCallId?: string;
	followLatest?: boolean;
	unseenEventCount?: number;
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
	} else {
		body = transcriptViewport(
			transcriptLines(state, safeWidth, safeHeight, paint),
			bodyHeight,
			state.followLatest !== false,
		);
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
	lines.push(paint("muted", clip(inputHint(width, state.streaming, state.focus), width)));
	return lines;
}

function inputHint(width: number, streaming: boolean, focus: TuiFocus | undefined): string {
	if (focus === "transcript") {
		if (width >= 72) {
			return " Up/Down select  Enter inspect  Left/Right view  Esc editor";
		}
		return " Up/Down select  Enter inspect  Esc editor";
	}
	const interrupt = streaming ? "Ctrl+C interrupt" : "Ctrl+C exit";
	if (width >= 72) {
		return ` Tab conversation  Enter send  Shift+Enter newline  ${interrupt}`;
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

interface TranscriptRender {
	lines: string[];
	selectedLine: number | undefined;
}

function transcriptLines(
	state: TuiFrameState,
	width: number,
	height: number,
	paint: (tone: Tone, text: string) => string,
): TranscriptRender {
	const rendered: string[] = [];
	let selectedLine: number | undefined;
	for (const entry of state.transcript) {
		const toolCallId = typeof entry === "string" ? undefined : entry.tool?.toolCallId;
		const selected =
			state.focus === "transcript" && toolCallId !== undefined && toolCallId === state.selectedToolCallId;
		if (selected) {
			selectedLine = rendered.length;
		}
		rendered.push(...renderTranscriptEntry(entry, width, paint, selected));
		if (state.inspector !== undefined && toolCallId !== undefined && state.inspector.tool.toolCallId === toolCallId) {
			rendered.push(...inlineInspectorLines(state.inspector, width, height, paint));
		}
	}
	if (state.followLatest === false && (state.unseenEventCount ?? 0) > 0) {
		rendered.push(paint("info", ` ↓ ${state.unseenEventCount} new events · End follow latest`));
	}
	return { lines: rendered, selectedLine };
}

function transcriptViewport(rendered: TranscriptRender, height: number, followLatest: boolean): string[] {
	if (followLatest || rendered.selectedLine === undefined) {
		return fitLines(rendered.lines.slice(-height), height);
	}
	const preferredStart = rendered.selectedLine - Math.floor(height / 3);
	const start = Math.max(0, Math.min(Math.max(0, rendered.lines.length - height), preferredStart));
	const visible = rendered.lines.slice(start, start + height);
	while (visible.length < height) {
		visible.push("");
	}
	return visible;
}

function renderTranscriptEntry(
	entry: TuiTranscriptEntry | string,
	width: number,
	paint: (tone: Tone, text: string) => string,
	selected: boolean,
): string[] {
	const presentation = transcriptPresentation(typeof entry === "string" ? legacyEntry(entry) : entry);
	const timestamp =
		typeof entry === "string" || entry.createdAt === undefined ? "" : `${formatTime(entry.createdAt)} `;
	const prefix = `${selected ? ">" : " "}${timestamp}${presentation.label} `;
	const continuation = " ".repeat(visibleWidth(prefix));
	const bodyWidth = Math.max(1, width - visibleWidth(prefix));
	const wrapped = wrap(clean(presentation.text), bodyWidth);
	return wrapped.map((part, index) => {
		const marker = index === 0 ? prefix : continuation;
		return `${paint(selected ? "accent" : presentation.tone, marker)}${part}`;
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

function inlineInspectorLines(
	inspector: TuiInspectorState,
	width: number,
	height: number,
	paint: (tone: Tone, text: string) => string,
): string[] {
	const view = inspector.view ?? "summary";
	const views = availableInspectorViews(inspector.tool);
	const tabs = views.map((item) => (item === view ? item.toUpperCase() : item)).join("  ");
	const prefix = "    ";
	const contentWidth = Math.max(1, width - visibleWidth(prefix));
	const maxRows = detailRowLimit(width, height);
	const detail = detailLines(inspector.tool, view)
		.flatMap((line) => wrap(clean(line), contentWidth))
		.slice(inspector.scrollOffset ?? 0, (inspector.scrollOffset ?? 0) + maxRows);
	const statusTone: Tone =
		inspector.tool.state === "running" ? "accent" : inspector.tool.state === "success" ? "success" : "error";
	return [
		paint("accent", `${prefix}${tabs}`),
		paint(statusTone, `${prefix}${toolStateLabel(inspector.tool)} · ${inspector.tool.toolName}`),
		...detail.map((line) => `${paint("muted", prefix)}${line}`),
	];
}

function detailRowLimit(width: number, height: number): number {
	if (width <= 80 && height <= 24) {
		return 6;
	}
	return width >= 110 ? 12 : 8;
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
