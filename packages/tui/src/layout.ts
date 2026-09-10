import { DEFAULT_COMPLETION_ROWS } from "./completion.ts";
import { renderMarkdown } from "./markdown.ts";
import type {
	TuiCompletionState,
	TuiFocus,
	TuiHeaderState,
	TuiInspectorState,
	TuiToolSnapshot,
	TuiTranscriptEntry,
} from "./model.ts";
import { clean, clip, color, padTo, type Tone, visibleWidth, wrap } from "./text.ts";
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
	completion?: TuiCompletionState;
	completionRows?: number;
	inspector?: TuiInspectorState;
	focus?: TuiFocus;
	selectedToolCallId?: string;
	followLatest?: boolean;
	unseenEventCount?: number;
	/** First visible transcript row. Undefined = anchored to the latest content. */
	transcriptScrollOffset?: number;
	streaming: boolean;
	/** Set false for a deliberately monochrome terminal. */
	colors?: boolean;
}

/** Render a stable terminal frame with a live editor and optional inspector. */
export function renderFrame(state: TuiFrameState, width: number, height: number): string[] {
	const safeWidth = Math.max(20, width);
	const safeHeight = Math.max(7, height);
	const paint = (tone: Tone, text: string): string => color(state.colors !== false, tone, text);
	const header = renderHeader(state, safeWidth, paint);
	const divider = paint("dim", "-".repeat(safeWidth));
	const footer = footerForHeight(state, safeWidth, safeHeight, paint);
	const reserved = 1 + 1 + footer.length;
	const bodyHeight = Math.max(0, safeHeight - reserved);
	let body: string[];
	if (state.picker) {
		body = fitLines(pickerLines(state.picker, safeWidth, paint).slice(-bodyHeight), bodyHeight);
	} else {
		body = transcriptViewportFor(state, width, height).lines;
	}
	return [header, divider, ...body, ...footer];
}

export interface TranscriptViewport {
	lines: string[];
	/** Largest valid scroll offset (0 when the transcript fits the viewport). */
	maxScroll: number;
	/** The offset actually applied for the current viewport. */
	start: number;
	bodyHeight: number;
}

/**
 * Compute the transcript viewport and scroll bounds. Shared by the renderer and
 * by session scroll commands so scrolling is always clamped identically.
 */
export function transcriptViewportFor(state: TuiFrameState, width: number, height: number): TranscriptViewport {
	const safeWidth = Math.max(20, width);
	const safeHeight = Math.max(7, height);
	const paint = (tone: Tone, text: string): string => color(state.colors !== false, tone, text);
	const footer = footerForHeight(state, safeWidth, safeHeight, paint);
	const reserved = 1 + 1 + footer.length;
	const bodyHeight = Math.max(0, safeHeight - reserved);
	const rendered = transcriptLines(state, safeWidth, safeHeight, paint);
	const maxScroll = Math.max(0, rendered.lines.length - bodyHeight);
	const viewport = transcriptViewport(
		rendered,
		bodyHeight,
		state.followLatest !== false,
		state.transcriptScrollOffset,
	);
	return { lines: viewport.lines, maxScroll, start: viewport.start, bodyHeight };
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
		...(state.header.context ? [paint("muted", `ctx: ${clean(state.header.context)}`)] : []),
		paint(statusTone, `status: ${state.streaming ? "RUNNING" : "READY"}`),
		paint("muted", `session: ${clean(state.header.session)}`),
	];
	return clip(fields.join("  "), width);
}

function footerForHeight(
	state: TuiFrameState,
	width: number,
	height: number,
	paint: (tone: Tone, text: string) => string,
): string[] {
	const baseline = footerLines(state, width, paint, 0);
	const minimumBodyRows = height > baseline.length + 2 ? 1 : 0;
	const available = Math.max(0, height - baseline.length - 2 - minimumBodyRows);
	const configured = completionRowCount(state.completionRows);
	return footerLines(state, width, paint, Math.min(configured, available));
}

function completionRowCount(value: number | undefined): number {
	if (value === undefined) {
		return DEFAULT_COMPLETION_ROWS;
	}
	return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : DEFAULT_COMPLETION_ROWS;
}

function footerLines(
	state: TuiFrameState,
	width: number,
	paint: (tone: Tone, text: string) => string,
	completionRows: number,
): string[] {
	if (state.picker) {
		return [paint("muted", clip(pickerHint(width), width))];
	}
	const lines: string[] = [];
	if (state.confirm) {
		lines.push(paint("warning", clip(` CONFIRM ${clean(state.confirm)}`, width)));
	}
	lines.push(...completionLines(state.completion, width, completionRows, paint));
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
	lines.push(
		paint("muted", clip(inputHint(width, state.streaming, state.focus, state.completion !== undefined), width)),
	);
	return lines;
}

function completionLines(
	completion: TuiCompletionState | undefined,
	width: number,
	maxRows: number,
	paint: (tone: Tone, text: string) => string,
): string[] {
	if (!completion || completion.items.length === 0 || maxRows <= 0) {
		return [];
	}
	const rowCount = Math.min(maxRows, completion.items.length);
	const selectedIndex = Math.max(0, Math.min(completion.items.length - 1, completion.index));
	const start = Math.max(0, Math.min(completion.items.length - rowCount, selectedIndex - rowCount + 1));
	return completion.items.slice(start, start + rowCount).map((candidate, offset) => {
		const selected = start + offset === selectedIndex;
		const label = candidate.kind === "command" ? "command" : "skill";
		const content = clean(`${selected ? ">" : " "} ${candidate.token}  ${candidate.description}  [${label}]`).replace(
			/\n/gu,
			" ",
		);
		return clip(paint(selected ? "accent" : "muted", content), width);
	});
}

function inputHint(width: number, streaming: boolean, focus: TuiFocus | undefined, completing: boolean): string {
	if (focus === "transcript") {
		if (width >= 100) {
			return " PgUp/PgDn scroll  Up/Down select  Home/End ends  Left/Right view  Enter inspect  Esc editor";
		}
		if (width >= 72) {
			return " PgUp/PgDn scroll  Up/Down select  Enter inspect  Esc editor";
		}
		if (width >= 54) {
			return " PgUp/PgDn scroll  Enter inspect  Esc editor";
		}
		return " PgUp/PgDn scroll  Esc editor";
	}
	if (completing) {
		if (width >= 72) {
			return " Tab accept/cycle  Shift+Tab reverse  Esc cancel  Enter send";
		}
		if (width >= 54) {
			return " Tab cycle  Shift+Tab reverse  Esc cancel";
		}
		return " Tab cycle  Esc cancel";
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
		rendered.push(...renderTranscriptEntry(entry, width, paint, selected, state.colors !== false));
		if (state.inspector !== undefined && toolCallId !== undefined && state.inspector.tool.toolCallId === toolCallId) {
			rendered.push(...inlineInspectorLines(state.inspector, width, height, paint));
		}
	}
	if (state.followLatest === false && (state.unseenEventCount ?? 0) > 0) {
		rendered.push(paint("info", ` ↓ ${state.unseenEventCount} new events · End follow latest`));
	}
	return { lines: rendered, selectedLine };
}

function transcriptViewport(
	rendered: TranscriptRender,
	height: number,
	followLatest: boolean,
	scrollOffset: number | undefined,
): { lines: string[]; start: number } {
	const maxScroll = Math.max(0, rendered.lines.length - height);
	if (height <= 0) {
		return { lines: [], start: maxScroll };
	}
	let start: number;
	let lines: string[];
	if (scrollOffset !== undefined) {
		start = Math.min(scrollOffset, maxScroll);
		lines = windowAt(rendered.lines, start, height);
	} else if (followLatest || rendered.selectedLine === undefined) {
		start = maxScroll;
		lines = fitLines(rendered.lines.slice(-height), height);
	} else {
		start = Math.max(0, Math.min(maxScroll, rendered.selectedLine - Math.floor(height / 3)));
		lines = windowAt(rendered.lines, start, height);
	}
	return { lines, start };
}

function windowAt(lines: string[], start: number, height: number): string[] {
	const visible = lines.slice(start, start + height);
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
	colors: boolean,
): string[] {
	const resolved = typeof entry === "string" ? legacyEntry(entry) : entry;
	const presentation = transcriptPresentation(resolved);
	const timestamp = resolved.createdAt === undefined ? "" : `${formatTime(resolved.createdAt)} `;
	const prefix = `${selected ? ">" : " "}${timestamp}${presentation.label} `;
	const continuation = " ".repeat(visibleWidth(prefix));
	const bodyWidth = Math.max(1, width - visibleWidth(prefix));
	const wrapped =
		resolved.kind === "assistant"
			? renderMarkdown(resolved.text, bodyWidth, { colors })
			: wrap(clean(presentation.text), bodyWidth);
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
	if (height <= 0) {
		return [];
	}
	const result = lines.slice(-height);
	while (result.length < height) {
		result.unshift("");
	}
	return result;
}
