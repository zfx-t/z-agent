import { DEFAULT_COMPLETION_ROWS } from "./completion.ts";
import { type ConfirmRequest, formatConfirmPrompt } from "./confirm.ts";
import { renderMarkdown } from "./markdown.ts";
import type {
	TuiCompletionState,
	TuiFocus,
	TuiHeaderState,
	TuiInspectorState,
	TuiToolRenderer,
	TuiToolSnapshot,
	TuiTranscriptEntry,
} from "./model.ts";
import { fitLabeledSegments } from "./segments.ts";
import { cellWidth, clean, clip, clipAnsi, color, padAnsi, type Tone, visibleWidth, wrap } from "./text.ts";
import { availableInspectorViews, detailLines, previewLine, toolTargetSummary } from "./tool-detail.ts";

export interface TuiPickerState {
	title: string;
	items: string[];
	index: number;
	query: string;
}

export interface TuiScrollInfo {
	/** First visible transcript row. */
	start: number;
	/** Largest valid scroll offset; 0 when everything fits. */
	maxScroll: number;
	bodyHeight: number;
}

export interface TuiFrameState {
	status: string;
	header?: TuiHeaderState;
	transcript: Array<TuiTranscriptEntry | string>;
	editorLines: string[];
	/** Cursor in display-line coordinates: row indexes editorLines, col counts characters. */
	editorCursor?: { row: number; col: number };
	/** Dim placeholder text for an empty editor. */
	editorPlaceholder?: string;
	confirm?: ConfirmRequest;
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
	toolRenderer?: TuiToolRenderer;
	/** Clock for elapsed labels; defaults to Date.now(). */
	now?: number;
	/** Spinner frame index; derived from `now` when absent. */
	tick?: number;
	/** Braille spinner and fast elapsed ticks; false = reduced motion. */
	motion?: boolean;
	/** Elapsed ms of the active run, shown next to RUNNING. */
	runElapsedMs?: number;
	/** Per-entry render cache shared across frames. */
	entryCache?: TuiEntryCache;
	/** Chrome glyph set; "unicode" default, "ascii" for font-poor terminals. */
	glyphTheme?: TuiGlyphTheme;
}

export interface TuiFrame {
	lines: string[];
	/** Real terminal cursor cell (0-indexed); absent when the cursor should hide. */
	cursor?: { row: number; col: number };
}

interface RenderClock {
	now: number;
	motion: boolean;
	tick: number;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const GUTTER = 7;
const EDITOR_MIN_ROWS = 2;

export type TuiGlyphTheme = "unicode" | "ascii";

/**
 * Chrome glyphs. The ASCII set avoids East-Asian Ambiguous code points for
 * terminals whose fonts or width tables cannot be trusted.
 */
export interface TuiGlyphs {
	rule: string;
	pipe: string;
	tl: string;
	tr: string;
	bl: string;
	br: string;
	prompt: string;
	ok: string;
	bad: string;
	preview: string;
	cursor: string;
	ellipsis: string;
	up: string;
	dot: string;
	caret: string;
	em: string;
}

const UNICODE_GLYPHS: TuiGlyphs = {
	rule: "─",
	pipe: "│",
	tl: "╭",
	tr: "╮",
	bl: "╰",
	br: "╯",
	prompt: "❯",
	ok: "✓",
	bad: "✗",
	preview: "⎿",
	cursor: "▌",
	ellipsis: "…",
	up: "↑",
	dot: "·",
	caret: "▏",
	em: "—",
};

const ASCII_GLYPHS: TuiGlyphs = {
	rule: "-",
	pipe: "|",
	tl: "+",
	tr: "+",
	bl: "+",
	br: "+",
	prompt: ">",
	ok: "+",
	bad: "x",
	preview: "`-",
	cursor: "|",
	ellipsis: "...",
	up: "^",
	dot: "-",
	caret: "|",
	em: "-",
};

function glyphsFor(state: TuiFrameState): TuiGlyphs {
	// Unicode chrome is width-correct under any ambiguous-width mode once
	// cellWidth knows the terminal's behavior; ascii stays an opt-out.
	return state.glyphTheme === "ascii" ? ASCII_GLYPHS : UNICODE_GLYPHS;
}

/** Repeat a glyph to fill `cells` terminal cells (handles 2-cell rules). */
function lineOf(glyph: string, cells: number): string {
	const per = Math.max(1, cellWidth(glyph));
	const count = Math.floor(cells / per);
	return glyph.repeat(count) + " ".repeat(cells - count * per);
}

/** left + fill + right bounded to `cells` terminal cells. */
function borderLine(left: string, fill: string, right: string, cells: number): string {
	const middle = Math.max(0, cells - cellWidth(left) - cellWidth(right));
	return `${left}${lineOf(fill, middle)}${right}`;
}

/** Render a stable terminal frame with a live editor and optional inspector. */
export function renderFrame(state: TuiFrameState, width: number, height: number): string[] {
	return renderFrameEx(state, width, height).lines;
}

export function renderFrameEx(state: TuiFrameState, width: number, height: number): TuiFrame {
	const safeWidth = Math.max(20, width);
	const safeHeight = Math.max(7, height);
	const clock = clockFor(state);
	const paint = (tone: Tone, text: string): string => color(state.colors !== false, tone, text);
	const g = glyphsFor(state);
	const header = renderHeader(state, safeWidth, paint, clock);
	const divider = paint("dim", lineOf(g.rule, safeWidth));
	let body: string[];
	let footer: { lines: string[]; cursor?: { row: number; col: number } };
	if (state.picker) {
		footer = footerBlock(state, safeWidth, safeHeight, paint, undefined);
		const bodyHeight = Math.max(0, safeHeight - 2 - footer.lines.length);
		body = fitLines(pickerLines(state.picker, safeWidth, paint, g).slice(-bodyHeight), bodyHeight);
	} else {
		const viewport = transcriptViewportFor(state, width, height);
		body = viewport.lines;
		const scroll: TuiScrollInfo = {
			start: viewport.start,
			maxScroll: viewport.maxScroll,
			bodyHeight: viewport.bodyHeight,
		};
		footer = footerBlock(state, safeWidth, safeHeight, paint, scroll);
	}
	// Belt: no painted line may exceed the terminal width — overflow wraps and
	// desynchronizes every absolute row write that follows.
	const lines = [header, divider, ...body, ...footer.lines].map((line) => clipAnsi(line, safeWidth, g.ellipsis));
	const cursor = footer.cursor
		? { row: lines.length - footer.lines.length + footer.cursor.row, col: footer.cursor.col }
		: undefined;
	return { lines, cursor };
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
	const clock = clockFor(state);
	const paint = (tone: Tone, text: string): string => color(state.colors !== false, tone, text);
	const bodyHeight = Math.max(0, safeHeight - 2 - footerLength(state, safeWidth, safeHeight, paint));
	const rendered = transcriptLines(state, safeWidth, safeHeight, paint, clock);
	const maxScroll = Math.max(0, rendered.lines.length - bodyHeight);
	const viewport = pickViewport(rendered, bodyHeight, state.followLatest !== false, state.transcriptScrollOffset);
	return { lines: viewport.lines, maxScroll, start: viewport.start, bodyHeight };
}

function clockFor(state: TuiFrameState): RenderClock {
	const now = state.now ?? Date.now();
	const motion = state.motion !== false;
	return { now, motion, tick: state.tick ?? Math.floor(now / 120) };
}

function spinner(clock: RenderClock): string {
	return clock.motion ? (SPINNER[clock.tick % SPINNER.length] ?? "⠋") : "";
}

export function formatElapsed(ms: number): string {
	const safe = Math.max(0, ms);
	if (safe < 1000) {
		return `${Math.round(safe)}ms`;
	}
	if (safe < 10_000) {
		return `${(safe / 1000).toFixed(1)}s`;
	}
	if (safe < 60_000) {
		return `${Math.round(safe / 1000)}s`;
	}
	const minutes = Math.floor(safe / 60_000);
	return `${minutes}m${Math.round((safe - minutes * 60_000) / 1000)}s`;
}

function renderHeader(
	state: TuiFrameState,
	width: number,
	paint: (tone: Tone, text: string) => string,
	clock: RenderClock,
): string {
	const statusTone: Tone = state.streaming ? "accent" : "success";
	const elapsed = formatElapsed(state.runElapsedMs ?? 0);
	const runText = state.streaming ? `RUNNING ${spinner(clock)} ${elapsed}`.replace(/\s+/gu, " ").trim() : "READY";
	const run = {
		id: "run",
		text: paint(statusTone, runText),
		priority: 100,
		required: true,
	};
	if (state.header?.segments && state.header.segments.length > 0) {
		const brand = paint("strong", " Z AGENT ");
		const body = fitLabeledSegments(
			[
				...state.header.segments.map((segment) => ({
					...segment,
					text: paint(segment.id === "run" ? statusTone : "muted", clean(segment.text)),
				})),
				run,
			],
			Math.max(0, width - visibleWidth(brand) - 2),
		);
		return clipAnsi(`${brand}  ${body}`, width, glyphsFor(state).ellipsis);
	}
	if (!state.header) {
		const g = glyphsFor(state);
		const fallback = `${paint("strong", " Z AGENT ")}${paint("dim", ` ${g.pipe} `)}${clean(state.status)}`;
		return clipAnsi(`${fallback}  ${paint(statusTone, runText)}`, width, g.ellipsis);
	}
	const fields = [
		{ id: "cwd", text: paint("muted", `cwd: ${clean(state.header.cwd)}`), priority: 40 },
		{ id: "model", text: paint("muted", `model: ${clean(state.header.model)}`), priority: 80 },
		...(state.header.context
			? [{ id: "ctx", text: paint("muted", `ctx: ${clean(state.header.context)}`), priority: 90 }]
			: []),
		run,
		{ id: "session", text: paint("muted", `session: ${clean(state.header.session)}`), priority: 30 },
	];
	const brand = paint("strong", " Z AGENT ");
	return clipAnsi(
		`${brand}  ${fitLabeledSegments(fields, Math.max(0, width - visibleWidth(brand) - 2))}`,
		width,
		glyphsFor(state).ellipsis,
	);
}

interface FooterBlock {
	lines: string[];
	/** Cursor position within `lines` (0-indexed cells). */
	cursor?: { row: number; col: number };
}

function footerLength(
	state: TuiFrameState,
	width: number,
	height: number,
	paint: (tone: Tone, text: string) => string,
): number {
	return footerBlock(state, width, height, paint, undefined).lines.length;
}

function footerBlock(
	state: TuiFrameState,
	width: number,
	height: number,
	paint: (tone: Tone, text: string) => string,
	scroll: TuiScrollInfo | undefined,
): FooterBlock {
	if (state.picker) {
		return { lines: [paint("muted", clip(pickerHint(width, glyphsFor(state)), width))] };
	}
	const g = glyphsFor(state);
	const lines: string[] = [];
	if (state.confirm) {
		lines.push(...confirmBlock(state.confirm, width, paint, g));
	}
	lines.push(...completionLines(state.completion, width, completionRowBudget(state, height, lines.length), paint));
	const box = editorBox(state, width, height, paint);
	const boxStart = lines.length;
	lines.push(...box.lines);
	lines.push(paint("muted", clip(inputHint(width, state, scroll), width)));
	return {
		lines,
		cursor: box.cursor === undefined ? undefined : { row: boxStart + box.cursor.row, col: box.cursor.col },
	};
}

function completionRowBudget(state: TuiFrameState, height: number, usedRows: number): number {
	if (!state.completion || state.completion.items.length === 0) {
		return 0;
	}
	// box borders + minimum editor rows + hint
	const baseRows = usedRows + 2 + EDITOR_MIN_ROWS + 1;
	const minimumBodyRows = height > baseRows + 2 ? 1 : 0;
	const available = Math.max(0, height - baseRows - 2 - minimumBodyRows);
	return Math.min(completionRowCount(state.completionRows), available);
}

function completionRowCount(value: number | undefined): number {
	if (value === undefined) {
		return DEFAULT_COMPLETION_ROWS;
	}
	return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : DEFAULT_COMPLETION_ROWS;
}

function confirmBlock(
	request: ConfirmRequest,
	width: number,
	paint: (tone: Tone, text: string) => string,
	g: TuiGlyphs,
): string[] {
	if (width < 40) {
		return [paint("warning", clip(` ${formatConfirmPrompt(request)}`, width))];
	}
	const summary = toolTargetSummary({
		toolCallId: "",
		toolName: request.toolName,
		input: request.args,
		argsText: compactArgs(request.args, g.ellipsis),
		state: "running",
	});
	return [
		paint("warning", clip(` CONFIRM allow ${request.toolName}`, width)),
		clip(`   ${summary}`, width),
		paint("muted", clip("   [y] once  [a] always  [n] deny  (esc denies)", width)),
	];
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
	const visible = completion.items.slice(start, start + rowCount);
	const tokenWidth = Math.max(...visible.map((candidate) => visibleWidth(candidate.token)));
	return visible.map((candidate, offset) => {
		const selected = start + offset === selectedIndex;
		const label = candidate.kind === "command" ? "command" : "skill";
		const pad = " ".repeat(Math.max(0, tokenWidth - visibleWidth(candidate.token)) + 2);
		const head = `${selected ? ">" : " "} ${candidate.token}${pad}`;
		const tail = `  [${label}]`;
		const descWidth = Math.max(0, width - visibleWidth(head) - visibleWidth(tail));
		const content = `${head}${clip(clean(candidate.description).replace(/\n/gu, " "), descWidth)}${tail}`;
		return clipAnsi(paint(selected ? "accent" : "muted", content), width);
	});
}

interface EditorBox {
	lines: string[];
	cursor?: { row: number; col: number };
}

function editorBox(
	state: TuiFrameState,
	width: number,
	height: number,
	paint: (tone: Tone, text: string) => string,
): EditorBox {
	const g = glyphsFor(state);
	const focused = state.focus !== "transcript";
	const frameTone: Tone = focused ? "accent" : "dim";
	const pipeW = cellWidth(g.pipe);
	const markerW = cellWidth(g.prompt) + 1;
	const contentWidth = Math.max(1, width - 2 * (pipeW + 1) - markerW);
	const display = state.editorLines.length > 0 ? state.editorLines.map((line) => clean(line)) : [""];
	const wanted = state.editorCursor ?? { row: 0, col: 0 };

	const wrapped: string[] = [];
	let cursorRow = 0;
	let cursorCol = 0;
	for (let row = 0; row < display.length; row += 1) {
		const line = display[row] ?? "";
		const part = wrapRowWithCursor(line, row === wanted.row ? wanted.col : -1, contentWidth);
		if (row === wanted.row) {
			cursorRow = wrapped.length + part.row;
			cursorCol = part.col;
		}
		wrapped.push(...part.rows);
	}
	if (wanted.row >= display.length) {
		cursorRow = wrapped.length - 1;
		cursorCol = visibleWidth(wrapped[wrapped.length - 1] ?? "");
	}
	if (wrapped.length === 0) {
		wrapped.push("");
	}

	const budget = Math.max(EDITOR_MIN_ROWS, Math.min(6, Math.floor(height / 4)));
	const winRows = Math.min(budget, wrapped.length);
	const start = Math.max(0, Math.min(cursorRow - winRows + 1, wrapped.length - winRows));
	const visible = wrapped.slice(start, start + winRows);
	while (visible.length < EDITOR_MIN_ROWS) {
		visible.push("");
	}

	const lines = [paint(frameTone, borderLine(g.tl, g.rule, g.tr, width))];
	const showPlaceholder = state.editorPlaceholder !== undefined && wrapped.length === 1 && (wrapped[0] ?? "") === "";
	for (const [index, text] of visible.entries()) {
		const marker = index === 0 ? paint("accent", `${g.prompt} `) : " ".repeat(markerW);
		const content =
			index === 0 && showPlaceholder
				? padAnsi(paint("muted", state.editorPlaceholder ?? ""), contentWidth, g.ellipsis)
				: padAnsi(text, contentWidth, g.ellipsis);
		lines.push(`${paint(frameTone, g.pipe)} ${marker}${content} ${paint(frameTone, g.pipe)}`);
	}
	lines.push(paint(frameTone, borderLine(g.bl, g.rule, g.br, width)));

	const showCursor = focused && state.confirm === undefined && state.picker === undefined;
	return {
		lines,
		cursor: showCursor ? { row: 1 + (cursorRow - start), col: pipeW + 1 + markerW + cursorCol } : undefined,
	};
}

/** Wrap one display row by cell width while tracking a character-offset cursor. */
function wrapRowWithCursor(
	line: string,
	cursorChars: number,
	width: number,
): { rows: string[]; row: number; col: number } {
	const safeWidth = Math.max(1, width);
	const rows: string[] = [];
	let current = "";
	let used = 0;
	let index = 0;
	let row = 0;
	let col = 0;
	for (const char of Array.from(line)) {
		const cw = cellWidth(char);
		if (used > 0 && used + cw > safeWidth) {
			rows.push(current);
			current = "";
			used = 0;
		}
		if (index === cursorChars) {
			row = rows.length;
			col = used;
		}
		current += char;
		used += cw;
		index += 1;
	}
	if (cursorChars < 0 || cursorChars >= index) {
		row = rows.length;
		col = used;
	}
	rows.push(current);
	if (col >= safeWidth) {
		row += 1;
		col = 0;
	}
	return { rows, row, col };
}

function inputHint(width: number, state: TuiFrameState, scroll: TuiScrollInfo | undefined): string {
	const g = glyphsFor(state);
	const detached = scroll !== undefined && state.followLatest === false;
	const unseen = detached && (state.unseenEventCount ?? 0) > 0 ? `${state.unseenEventCount} new events · ` : "";
	const scrollTag = detached ? `↑ ${scroll.maxScroll > 0 ? "scrolled · " : ""}${unseen}End latest · ` : "";
	let hint: string;
	if (state.focus === "transcript") {
		if (width >= 100) {
			hint = `${scrollTag}up/down select · enter inspect · left/right views · pgup/pgdn scroll · g/G ends · esc editor`;
		} else if (width >= 72) {
			hint = `${scrollTag}up/down select · enter inspect · pgup/pgdn scroll · esc editor`;
		} else if (width >= 54) {
			hint = `${scrollTag}enter inspect · esc editor`;
		} else {
			hint = `${scrollTag}esc editor`;
		}
	} else if (state.completion !== undefined) {
		if (width >= 72) {
			hint = " up/down select · tab cycle · esc cancel · enter send";
		} else if (width >= 54) {
			hint = " up/down select · tab cycle · esc cancel";
		} else {
			hint = " up/down select · esc cancel";
		}
	} else {
		const interrupt = state.streaming ? "ctrl+c interrupt" : "ctrl+c exit";
		if (width >= 112) {
			hint = `${scrollTag}enter send · shift+enter newline · tab transcript · ctrl+p commands · ctrl+t thinking · wheel scroll · ${interrupt}`;
		} else if (width >= 100) {
			hint = `${scrollTag}enter send · shift+enter newline · tab transcript · ctrl+p commands · ${interrupt}`;
		} else if (width >= 72) {
			hint = `${scrollTag}enter send · shift+enter newline · tab transcript · ${interrupt}`;
		} else if (width >= 54) {
			hint = `${scrollTag}enter send · shift+enter newline · ${interrupt}`;
		} else if (width >= 34) {
			hint = `${scrollTag}enter send · ${interrupt}`;
		} else {
			hint = `${scrollTag}enter send`;
		}
	}
	return hint.replaceAll("·", g.dot).replaceAll("↑", g.up);
}

function pickerHint(width: number, g: TuiGlyphs): string {
	const hint =
		width >= 46
			? " up/down select · enter confirm · 1-9 jump · esc cancel"
			: " up/down select · enter confirm · esc cancel";
	return hint.replaceAll("·", g.dot);
}

function pickerLines(
	picker: TuiPickerState,
	width: number,
	paint: (tone: Tone, text: string) => string,
	g: TuiGlyphs,
): string[] {
	const lines = [
		paint("strong", ` ${clean(picker.title)}`),
		`${paint("dim", " filter: ")}${clean(picker.query)}${paint("dim", g.caret)}`,
	];
	if (picker.items.length === 0) {
		lines.push(paint("muted", " no matches"));
		return lines;
	}
	for (let index = 0; index < picker.items.length; index += 1) {
		const selected = index === picker.index;
		const prefix = selected ? ">" : " ";
		const text = ` ${prefix} ${index + 1}. ${clean(picker.items[index] ?? "")}`;
		lines.push(clipAnsi(selected ? paint("accent", text) : text, width, g.ellipsis));
	}
	return lines;
}

interface TranscriptRender {
	lines: string[];
	selectedLine: number | undefined;
}

interface CachedEntry {
	key: EntryKey;
	lines: string[];
}

export type TuiEntryCache = WeakMap<TuiTranscriptEntry, CachedEntry>;

interface EntryKey {
	width: number;
	colors: boolean;
	selected: boolean;
	tail: boolean;
	motion: boolean;
	text: string;
	hidden: boolean | undefined;
	queued: boolean | undefined;
	tool: ToolKey | undefined;
}

interface ToolKey {
	name: string;
	args: string;
	state: string;
	output: string | undefined;
	details: string | undefined;
	duration: number | undefined;
	marker: string;
}

function transcriptLines(
	state: TuiFrameState,
	width: number,
	height: number,
	paint: (tone: Tone, text: string) => string,
	clock: RenderClock,
): TranscriptRender {
	const rendered: string[] = [];
	let selectedLine: number | undefined;
	const entries = state.transcript;
	const lastEntry = entries.at(-1);
	for (const [index, entry] of entries.entries()) {
		const toolCallId = typeof entry === "string" ? undefined : entry.tool?.toolCallId;
		const selected =
			state.focus === "transcript" && toolCallId !== undefined && toolCallId === state.selectedToolCallId;
		if (selected) {
			selectedLine = rendered.length;
		}
		const tail = state.streaming && typeof entry !== "string" && entry.kind === "assistant" && entry === lastEntry;
		const blankBefore = typeof entry !== "string" && entry.kind === "user" && index > 0;
		if (blankBefore) {
			rendered.push("");
		}
		rendered.push(
			...renderEntry(entry, {
				state,
				width,
				height,
				paint,
				clock,
				selected,
				tail,
			}),
		);
		if (state.inspector !== undefined && toolCallId !== undefined && state.inspector.tool.toolCallId === toolCallId) {
			rendered.push(
				...inlineInspectorLines(state.inspector, width, height, paint, state.toolRenderer, glyphsFor(state)),
			);
		}
	}
	if (state.streaming) {
		const active =
			typeof lastEntry === "object" &&
			lastEntry !== undefined &&
			(lastEntry.kind === "assistant" ||
				lastEntry.kind === "thinking" ||
				(lastEntry.kind === "tool" && lastEntry.tool?.state === "running"));
		if (!active) {
			const spin = spinner(clock);
			const label = `${spin ? `${spin} ` : ""}waiting for model`;
			rendered.push(paint("accent", `${" ".repeat(GUTTER)}${label}`));
		}
	}
	return { lines: rendered, selectedLine };
}

interface EntryContext {
	state: TuiFrameState;
	width: number;
	height: number;
	paint: (tone: Tone, text: string) => string;
	clock: RenderClock;
	selected: boolean;
	tail: boolean;
}

function renderEntry(entry: TuiTranscriptEntry | string, cx: EntryContext): string[] {
	if (typeof entry === "string") {
		return renderPlainEntry(legacyEntry(entry), cx);
	}
	const key = entryKey(entry, cx);
	const cached = cx.state.entryCache?.get(entry);
	if (cached && sameKey(cached.key, key)) {
		return cached.lines;
	}
	const lines = entry.kind === "tool" && entry.tool ? renderToolEntry(entry, cx) : renderPlainEntry(entry, cx);
	cx.state.entryCache?.set(entry, { key, lines });
	return lines;
}

function entryKey(entry: TuiTranscriptEntry, cx: EntryContext): EntryKey {
	const tool = entry.tool;
	return {
		width: cx.width,
		colors: cx.state.colors !== false,
		selected: cx.selected,
		tail: cx.tail,
		motion: cx.clock.motion,
		text: entry.text,
		hidden: entry.hidden,
		queued: entry.queued,
		tool: tool
			? {
					name: tool.toolName,
					args: tool.argsText,
					state: tool.state,
					output: tool.outputText,
					details: tool.detailsText,
					duration: tool.durationMs,
					marker: toolMarker(tool, cx).text,
				}
			: undefined,
	};
}

function sameKey(left: EntryKey, right: EntryKey): boolean {
	if (
		left.width !== right.width ||
		left.colors !== right.colors ||
		left.selected !== right.selected ||
		left.tail !== right.tail ||
		left.motion !== right.motion ||
		left.text !== right.text ||
		left.hidden !== right.hidden ||
		left.queued !== right.queued
	) {
		return false;
	}
	if (left.tool === undefined || right.tool === undefined) {
		return left.tool === right.tool;
	}
	return (
		left.tool.name === right.tool.name &&
		left.tool.args === right.tool.args &&
		left.tool.state === right.tool.state &&
		left.tool.output === right.tool.output &&
		left.tool.details === right.tool.details &&
		left.tool.duration === right.tool.duration &&
		left.tool.marker === right.tool.marker
	);
}

interface Presentation {
	label: string;
	tone: Tone;
	bodyTone?: Tone;
}

function presentation(entry: TuiTranscriptEntry): Presentation {
	switch (entry.kind) {
		case "user":
			return { label: "YOU", tone: "accent" };
		case "assistant":
			return { label: "AI", tone: "strong" };
		case "thinking":
			return { label: "THINK", tone: "muted", bodyTone: "muted" };
		case "tool":
			return { label: "TOOL", tone: "info" };
		case "warning":
			return { label: "WARN", tone: "warning", bodyTone: "warning" };
		case "error":
			return { label: "ERROR", tone: "error", bodyTone: "error" };
		default:
			return { label: "INFO", tone: "muted", bodyTone: "muted" };
	}
}

function renderPlainEntry(entry: TuiTranscriptEntry, cx: EntryContext): string[] {
	const p = presentation(entry);
	const g = glyphsFor(cx.state);
	const bodyWidth = Math.max(1, cx.width - GUTTER);
	let text = entry.text;
	if (entry.kind === "thinking" && entry.hidden) {
		text = `(hidden ${g.em} ctrl+t to expand)`;
	} else if (entry.kind === "user" && entry.queued) {
		text = `${text}  (queued)`;
	}
	const wrapped =
		entry.kind === "assistant"
			? renderMarkdown(text, bodyWidth, { colors: cx.state.colors !== false })
			: wrap(clean(text), bodyWidth);
	const label = cx.paint(cx.selected ? "accent" : p.tone, `${cx.selected ? ">" : " "}${p.label.padEnd(5)} `);
	const continuation = " ".repeat(GUTTER);
	const lines = wrapped.map((part, index) => {
		const head = index === 0 ? label : continuation;
		const body = p.bodyTone ? cx.paint(p.bodyTone, part) : part;
		return `${head}${body}`;
	});
	if (cx.tail && lines.length > 0) {
		const last = lines.length - 1;
		if (visibleWidth(lines[last] ?? "") + cellWidth(g.cursor) <= cx.width) {
			lines[last] = `${lines[last]}${cx.paint("accent", g.cursor)}`;
		}
	}
	return lines;
}

function renderToolEntry(entry: TuiTranscriptEntry, cx: EntryContext): string[] {
	const tool = entry.tool;
	if (!tool) {
		return renderPlainEntry(entry, cx);
	}
	const marker = toolMarker(tool, cx);
	const g = glyphsFor(cx.state);
	const bodyWidth = Math.max(1, cx.width - GUTTER);
	const markerWidth = visibleWidth(marker.text);
	const summaryWidth = Math.max(1, bodyWidth - markerWidth - 1);
	const label = cx.paint(cx.selected ? "accent" : "info", `${cx.selected ? ">" : " "}TOOL  `);
	const summary = clipEnd(clean(`${tool.toolName} ${toolTargetSummary(tool)}`), summaryWidth, g.ellipsis);
	const head = `${label}${padAnsi(summary, summaryWidth, g.ellipsis)} ${cx.paint(marker.tone, marker.text)}`;
	const lines = [head];
	const preview = previewLine(tool);
	if (preview) {
		const more = preview.more > 0 ? ` ${g.dot} +${preview.more} lines` : "";
		const tone: Tone = tool.state === "error" ? "error" : "muted";
		lines.push(
			`${" ".repeat(GUTTER)}${cx.paint(tone, clipEnd(`${g.preview} ${clean(preview.text)}${more}`, bodyWidth, g.ellipsis))}`,
		);
	}
	return lines;
}

function clipEnd(text: string, width: number, ellipsis = "…"): string {
	if (visibleWidth(text) <= width) {
		return text;
	}
	const limit = Math.max(0, width - cellWidth(ellipsis));
	let out = "";
	let used = 0;
	for (const char of Array.from(text)) {
		const cw = cellWidth(char);
		if (used + cw > limit) {
			return `${out}${ellipsis}`;
		}
		out += char;
		used += cw;
	}
	return out;
}

function toolMarker(tool: TuiToolSnapshot, cx: EntryContext): { text: string; tone: Tone } {
	if (tool.state === "running") {
		const elapsed = formatElapsed(Math.max(0, cx.clock.now - (tool.startedAt ?? cx.clock.now)));
		const spin = spinner(cx.clock);
		return { text: spin ? `${spin} ${elapsed}` : `RUNNING ${elapsed}`, tone: "accent" };
	}
	const duration = tool.durationMs === undefined ? "" : ` ${formatElapsed(tool.durationMs)}`;
	const g = glyphsFor(cx.state);
	return tool.state === "success"
		? { text: `${g.ok} DONE${duration}`, tone: "success" }
		: { text: `${g.bad} FAIL${duration}`, tone: "error" };
}

function legacyEntry(text: string): TuiTranscriptEntry {
	return { id: "legacy", kind: "info", text };
}

function pickViewport(
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

function inlineInspectorLines(
	inspector: TuiInspectorState,
	width: number,
	height: number,
	paint: (tone: Tone, text: string) => string,
	renderer: TuiToolRenderer | undefined,
	g: TuiGlyphs,
): string[] {
	const view = inspector.view ?? "summary";
	const views = availableInspectorViews(inspector.tool, renderer);
	const tabs = views.map((item) => (item === view ? item.toUpperCase() : item)).join("  ");
	const prefix = " ".repeat(GUTTER);
	const contentWidth = Math.max(1, width - visibleWidth(prefix));
	const maxRows = detailRowLimit(width, height);
	const detail = detailLines(inspector.tool, view, renderer)
		.flatMap((line) => wrap(clean(line), contentWidth))
		.slice(inspector.scrollOffset ?? 0, (inspector.scrollOffset ?? 0) + maxRows);
	const statusTone: Tone =
		inspector.tool.state === "running" ? "accent" : inspector.tool.state === "success" ? "success" : "error";
	const marker = inspector.tool.state === "running" ? "RUNNING" : inspector.tool.state === "success" ? "DONE" : "FAIL";
	return [
		paint("accent", `${prefix}${tabs}`),
		paint(statusTone, `${prefix}${marker} ${g.dot} ${inspector.tool.toolName}`),
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

function compactArgs(value: unknown, ellipsis = "…"): string {
	let text: string;
	try {
		text = JSON.stringify(value) ?? "";
	} catch {
		text = String(value);
	}
	return text.length <= 160 ? text : `${text.slice(0, 160)}${ellipsis}`;
}
