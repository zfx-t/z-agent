import { DEFAULT_COMPLETION_ROWS } from "./completion.ts";
import { type ConfirmChoice, type ConfirmRequest, formatConfirmPrompt } from "./confirm.ts";
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

/** What a mouse press on a screen region means. */
export type TuiHitTarget =
	| { kind: "entry"; entryId: string }
	| { kind: "inspectorTab"; entryId: string; view: "summary" | "output" | "diff" }
	| { kind: "inspectorBody"; entryId: string }
	| { kind: "picker"; index: number }
	| { kind: "confirm"; choice: ConfirmChoice }
	| {
			kind: "editor";
			/** Display line index (pre-wrap) the clicked wrapped row belongs to. */
			displayRow: number;
			/** Char index just past this row's last content char; a click past the row lands here. */
			charEnd: number;
			/** Per-cell char offsets: cells[c - col0] = char index within the display line. */
			cells: number[];
	  }
	| { kind: "followLatest" };

/** A painted rectangle that answers a mouse press. Coordinates are 0-indexed, col1 exclusive. */
export interface TuiHitRegion {
	row: number;
	col0: number;
	col1: number;
	target: TuiHitTarget;
}

export interface TuiFrameState {
	status: string;
	header?: TuiHeaderState;
	transcript: Array<TuiTranscriptEntry | string>;
	editorLines: string[];
	/** Cursor in display-line coordinates: row indexes editorLines, col counts characters. */
	editorCursor?: { row: number; col: number };
	/** Selected text as per-display-line char spans; painted inverse in the editor box. */
	editorSelection?: Array<{ row: number; start: number; end: number }>;
	/** Dim placeholder text for an empty editor. */
	editorPlaceholder?: string;
	confirm?: ConfirmRequest;
	/** Which confirm choice is keyboard-focused (arrow/tab navigation before Enter). */
	confirmFocused?: ConfirmChoice;
	/** One-shot hint line override (e.g. "esc again: clear draft"). */
	hint?: string;
	picker?: TuiPickerState;
	completion?: TuiCompletionState;
	completionRows?: number;
	inspector?: TuiInspectorState;
	focus?: TuiFocus;
	/** Selected transcript entry (any kind; only tool entries expand inspectors). */
	selectedEntryId?: string;
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
	/** Clickable rectangles, refreshed every frame; empty when mouse is off. */
	hits: TuiHitRegion[];
	/** Transcript/picker body row count — the wheel-scroll viewport height. */
	bodyHeight: number;
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
	const hits: TuiHitRegion[] = [];
	let body: string[];
	let footer: { lines: string[]; cursor?: { row: number; col: number }; hits: TuiHitRegion[] };
	let bodyHeight = 0;
	if (state.picker) {
		footer = footerBlock(state, safeWidth, safeHeight, paint, undefined);
		bodyHeight = Math.max(0, safeHeight - 2 - footer.lines.length);
		const pickerBody = pickerLines(state.picker, safeWidth, paint, g);
		const visible = pickerBody.slice(-bodyHeight);
		body = fitLines(visible, bodyHeight);
		const padding = bodyHeight - visible.length;
		const dropped = pickerBody.length - visible.length;
		for (let row = 0; row < visible.length; row += 1) {
			const index = dropped + row - 2; // title + filter rows
			if (index >= 0) {
				hits.push({
					row: 2 + padding + row,
					col0: 0,
					col1: safeWidth,
					target: { kind: "picker", index },
				});
			}
		}
	} else {
		const viewport = transcriptViewportFor(state, width, height);
		body = viewport.lines;
		bodyHeight = viewport.bodyHeight;
		for (const [index, entryId] of viewport.entryIds.entries()) {
			const row = 2 + index;
			const tabSpans = viewport.tabs[index];
			if (tabSpans) {
				for (const span of tabSpans) {
					hits.push({
						row,
						col0: span.col0,
						col1: span.col1,
						target: { kind: "inspectorTab", entryId: entryId ?? "", view: span.view },
					});
				}
			}
			if (entryId !== undefined) {
				hits.push({
					row,
					col0: 0,
					col1: safeWidth,
					target: viewport.inspectorLines[index] ? { kind: "inspectorBody", entryId } : { kind: "entry", entryId },
				});
			}
		}
		const scroll: TuiScrollInfo = {
			start: viewport.start,
			maxScroll: viewport.maxScroll,
			bodyHeight: viewport.bodyHeight,
		};
		footer = footerBlock(state, safeWidth, safeHeight, paint, scroll);
	}
	const footerStart = 2 + body.length;
	for (const hit of footer.hits) {
		hits.push({ ...hit, row: hit.row + footerStart });
	}
	// Belt: no painted line may exceed the terminal width — overflow wraps and
	// desynchronizes every absolute row write that follows.
	const lines = [header, divider, ...body, ...footer.lines].map((line) => clipAnsi(line, safeWidth, g.ellipsis));
	const cursor = footer.cursor
		? { row: lines.length - footer.lines.length + footer.cursor.row, col: footer.cursor.col }
		: undefined;
	return { lines, cursor, hits, bodyHeight };
}

export interface TranscriptViewport {
	lines: string[];
	/** Entry id behind each visible line; undefined for blanks and status rows. */
	entryIds: (string | undefined)[];
	/** Clickable inspector tab spans per visible line. */
	tabs: ({ col0: number; col1: number; view: "summary" | "output" | "diff" }[] | undefined)[];
	/** True for lines inside the open inspector body (wheel scrolls it). */
	inspectorLines: boolean[];
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
	return {
		lines: viewport.lines,
		entryIds: viewport.entryIds,
		tabs: viewport.tabs,
		inspectorLines: viewport.inspectorLines,
		maxScroll,
		start: viewport.start,
		bodyHeight,
	};
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
	/** Clickable regions, rows relative to the footer block start. */
	hits: TuiHitRegion[];
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
	const g = glyphsFor(state);
	const hits: TuiHitRegion[] = [];
	if (state.picker) {
		return { lines: [paint("muted", clip(pickerHint(width, g), width))], hits };
	}
	const lines: string[] = [];
	if (state.confirm) {
		const block = confirmBlock(state.confirm, width, paint, g, state.confirmFocused);
		for (const span of block.spans) {
			hits.push({
				row: span.row,
				col0: span.col0,
				col1: span.col1,
				target: { kind: "confirm", choice: span.choice },
			});
		}
		lines.push(...block.lines);
	}
	lines.push(...completionLines(state.completion, width, completionRowBudget(state, height, lines.length), paint));
	const box = editorBox(state, width, height, paint);
	const boxStart = lines.length;
	const pipeW = cellWidth(g.pipe);
	const markerW = cellWidth(g.prompt) + 1;
	const contentCol = pipeW + 1 + markerW;
	const contentWidth = Math.max(1, width - 2 * (pipeW + 1) - markerW);
	for (const [index, rowMap] of box.hitRows.entries()) {
		hits.push({
			row: boxStart + 1 + index,
			col0: contentCol,
			col1: contentCol + contentWidth,
			target: { kind: "editor", displayRow: rowMap.displayRow, charEnd: rowMap.charEnd, cells: rowMap.cells },
		});
	}
	lines.push(...box.lines);
	const hint = inputHint(width, state, scroll);
	lines.push(paint("muted", clip(hint.text, width)));
	if (hint.followCells > 0) {
		hits.push({ row: lines.length - 1, col0: 0, col1: hint.followCells, target: { kind: "followLatest" } });
	}
	return {
		lines,
		cursor: box.cursor === undefined ? undefined : { row: boxStart + box.cursor.row, col: box.cursor.col },
		hits,
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

export const CONFIRM_ORDER: readonly ConfirmChoice[] = ["once", "always", "deny"];

const CONFIRM_LABELS: Record<ConfirmChoice, string> = {
	once: "[y] once",
	always: "[a] always",
	deny: "[n] deny",
};

function confirmBlock(
	request: ConfirmRequest,
	width: number,
	paint: (tone: Tone, text: string) => string,
	g: TuiGlyphs,
	focused: ConfirmChoice | undefined,
): { lines: string[]; spans: Array<{ choice: ConfirmChoice; col0: number; col1: number; row: number }> } {
	if (width < 40) {
		return { lines: [paint("warning", clip(` ${formatConfirmPrompt(request)}`, width))], spans: [] };
	}
	const summary = toolTargetSummary({
		toolCallId: "",
		toolName: request.toolName,
		input: request.args,
		argsText: compactArgs(request.args, g.ellipsis),
		state: "running",
	});
	const spans: Array<{ choice: ConfirmChoice; col0: number; col1: number; row: number }> = [];
	let column = 3;
	const choices = CONFIRM_ORDER.map((choice, index) => {
		const label = CONFIRM_LABELS[choice];
		spans.push({ choice, col0: column, col1: column + label.length, row: 2 });
		column += label.length + (index === CONFIRM_ORDER.length - 1 ? 0 : 2);
		return choice === focused ? paint("accent", `\x1b[7m${label}\x1b[27m`) : paint("muted", label);
	});
	return {
		lines: [
			paint("warning", clip(` CONFIRM allow ${request.toolName}`, width)),
			clip(`   ${summary}`, width),
			`   ${choices.join("  ")}${paint("dim", "  (esc denies)")}`,
		],
		spans,
	};
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
	/** Click map for each visible content row (display line + cell→char table). */
	hitRows: Array<{ displayRow: number; charEnd: number; cells: number[] }>;
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
	const selection = state.editorSelection ?? [];

	const wrapped: string[] = [];
	const rowMaps: Array<{ displayRow: number; charEnd: number; cells: number[] }> = [];
	let cursorRow = 0;
	let cursorCol = 0;
	for (let row = 0; row < display.length; row += 1) {
		const line = display[row] ?? "";
		const sel = selection.find((span) => span.row === row);
		const part = wrapRowWithCursor(line, row === wanted.row ? wanted.col : -1, contentWidth, sel);
		if (row === wanted.row) {
			cursorRow = wrapped.length + part.row;
			cursorCol = part.col;
		}
		for (const [index, text] of part.rows.entries()) {
			const span = part.sel[index];
			wrapped.push(span ? invertRange(text, span.start, span.end) : text);
			rowMaps.push({
				displayRow: row,
				charEnd: part.charEnd[index] ?? 0,
				cells: part.cells[index] ?? [],
			});
		}
	}
	if (wanted.row >= display.length) {
		cursorRow = wrapped.length - 1;
		cursorCol = visibleWidth(wrapped[wrapped.length - 1] ?? "");
	}
	if (wrapped.length === 0) {
		wrapped.push("");
		rowMaps.push({ displayRow: 0, charEnd: 0, cells: [] });
	}

	const budget = Math.max(EDITOR_MIN_ROWS, Math.min(6, Math.floor(height / 4)));
	const winRows = Math.min(budget, wrapped.length);
	const start = Math.max(0, Math.min(cursorRow - winRows + 1, wrapped.length - winRows));
	const visible = wrapped.slice(start, start + winRows);
	const hitRows = rowMaps.slice(start, start + winRows);
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
		hitRows,
	};
}

/** Paint `text[start, end)` inverse-video (row strings are ANSI-free). */
function invertRange(text: string, start: number, end: number): string {
	if (end <= start) {
		return text;
	}
	return `${text.slice(0, start)}\x1b[7m${text.slice(start, end)}\x1b[27m${text.slice(end)}`;
}

/** Wrap one display row by cell width while tracking a character-offset cursor. */
function wrapRowWithCursor(
	line: string,
	cursorChars: number,
	width: number,
	selection?: { start: number; end: number },
): {
	rows: string[];
	row: number;
	col: number;
	/** Per output row: cell column → char index within the display line. */
	cells: number[][];
	/** Per output row: char index just past its last content char. */
	charEnd: number[];
	/** Per output row: selected char span (in row-local char indices), if any. */
	sel: Array<{ start: number; end: number } | undefined>;
} {
	const safeWidth = Math.max(1, width);
	const rows: string[] = [];
	const cells: number[][] = [];
	const charEnd: number[] = [];
	const sel: Array<{ start: number; end: number } | undefined> = [];
	let current = "";
	let rowCells: number[] = [];
	let used = 0;
	// Offsets are UTF-16 indices throughout: the editor, displaySelection, and
	// string slices all count code units, so astral chars stay consistent.
	let index = 0;
	let row = 0;
	let col = 0;
	const flush = (): void => {
		rows.push(current);
		cells.push(rowCells);
		charEnd.push(index);
		if (selection) {
			const rowStart = rowCells[0] ?? index;
			const rowEnd = index;
			const start = Math.max(0, selection.start - rowStart);
			const end = Math.min(rowEnd - rowStart, selection.end - rowStart);
			sel.push(end > start ? { start, end } : undefined);
		} else {
			sel.push(undefined);
		}
	};
	for (const char of Array.from(line)) {
		const cw = cellWidth(char);
		if (used > 0 && used + cw > safeWidth) {
			flush();
			current = "";
			rowCells = [];
			used = 0;
		}
		if (index === cursorChars) {
			row = rows.length;
			col = used;
		}
		current += char;
		for (let cell = 0; cell < cw; cell += 1) {
			rowCells.push(index);
		}
		used += cw;
		index += char.length;
	}
	if (cursorChars < 0 || cursorChars >= index) {
		row = rows.length;
		col = used;
	}
	flush();
	if (col >= safeWidth) {
		row += 1;
		col = 0;
	}
	return { rows, row, col, cells, charEnd, sel };
}

function inputHint(
	width: number,
	state: TuiFrameState,
	scroll: TuiScrollInfo | undefined,
): { text: string; followCells: number } {
	const g = glyphsFor(state);
	if (state.hint !== undefined) {
		return { text: state.hint, followCells: 0 };
	}
	const detached = scroll !== undefined && state.followLatest === false;
	const unseen = detached && (state.unseenEventCount ?? 0) > 0 ? `${state.unseenEventCount} new events · ` : "";
	const scrollTag = detached ? `↑ ${scroll.maxScroll > 0 ? "scrolled · " : ""}${unseen}End latest · ` : "";
	let hint: string;
	if (state.focus === "transcript") {
		if (width >= 100) {
			hint = `${scrollTag}up/down select · enter inspect · left/right views · pgup/pgdn scroll · home/end ends · esc editor`;
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
	const text = hint.replaceAll("·", g.dot).replaceAll("↑", g.up);
	const tag = scrollTag.replaceAll("·", g.dot).replaceAll("↑", g.up);
	return { text, followCells: tag.length === 0 ? 0 : visibleWidth(tag) };
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
	/** Entry id behind each line; undefined for blanks, status rows, and string entries. */
	entryIds: (string | undefined)[];
	/** Clickable inspector tab spans per line (inspector header rows only). */
	tabs: (InspectorTabSpan[] | undefined)[];
	/** Lines belonging to the open inspector body (wheel scroll target). */
	inspectorLines: boolean[];
}

/** One clickable view name inside an inspector tab row. */
interface InspectorTabSpan {
	col0: number;
	col1: number;
	view: "summary" | "output" | "diff";
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
	const entryIds: (string | undefined)[] = [];
	const tabs: (InspectorTabSpan[] | undefined)[] = [];
	const inspectorLines: boolean[] = [];
	let selectedLine: number | undefined;
	const entries = state.transcript;
	const lastEntry = entries.at(-1);
	for (const [index, entry] of entries.entries()) {
		const entryId = typeof entry === "string" ? undefined : entry.id;
		const selected = state.focus === "transcript" && entryId !== undefined && entryId === state.selectedEntryId;
		if (selected) {
			selectedLine = rendered.length;
		}
		const tail = state.streaming && typeof entry !== "string" && entry.kind === "assistant" && entry === lastEntry;
		const blankBefore = typeof entry !== "string" && entry.kind === "user" && index > 0;
		if (blankBefore) {
			rendered.push("");
			entryIds.push(undefined);
			tabs.push(undefined);
			inspectorLines.push(false);
		}
		const entryStart = rendered.length;
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
		for (let line = entryStart; line < rendered.length; line += 1) {
			entryIds.push(entryId);
			tabs.push(undefined);
			inspectorLines.push(false);
		}
		const toolCallId = typeof entry === "string" ? undefined : entry.tool?.toolCallId;
		if (state.inspector !== undefined && toolCallId !== undefined && state.inspector.tool.toolCallId === toolCallId) {
			const block = inlineInspectorLines(
				state.inspector,
				width,
				height,
				paint,
				state.toolRenderer,
				glyphsFor(state),
			);
			for (const [lineIndex, line] of block.lines.entries()) {
				rendered.push(line);
				entryIds.push(entryId);
				tabs.push(lineIndex === 0 ? block.tabSpans : undefined);
				inspectorLines.push(true);
			}
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
			entryIds.push(undefined);
			tabs.push(undefined);
			inspectorLines.push(false);
		}
	}
	return { lines: rendered, selectedLine, entryIds, tabs, inspectorLines };
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
): Pick<TranscriptViewport, "lines" | "entryIds" | "tabs" | "inspectorLines" | "start"> {
	const maxScroll = Math.max(0, rendered.lines.length - height);
	const slice = (
		start: number,
		lines: string[],
	): Pick<TranscriptViewport, "lines" | "entryIds" | "tabs" | "inspectorLines" | "start"> => ({
		lines,
		entryIds: rendered.entryIds.slice(start, start + lines.length),
		tabs: rendered.tabs.slice(start, start + lines.length),
		inspectorLines: rendered.inspectorLines.slice(start, start + lines.length),
		start,
	});
	if (height <= 0) {
		return { lines: [], entryIds: [], tabs: [], inspectorLines: [], start: maxScroll };
	}
	if (scrollOffset !== undefined) {
		const start = Math.min(scrollOffset, maxScroll);
		return slice(start, windowAt(rendered.lines, start, height));
	}
	if (followLatest || rendered.selectedLine === undefined) {
		const start = maxScroll;
		const lines = rendered.lines.slice(-height);
		const startIndex = rendered.lines.length - lines.length;
		return {
			lines: fitLines(lines, height),
			entryIds: padStart(rendered.entryIds.slice(startIndex), height),
			tabs: padStart(rendered.tabs.slice(startIndex), height),
			inspectorLines: padStart(rendered.inspectorLines.slice(startIndex), height),
			start,
		};
	}
	const start = Math.max(0, Math.min(maxScroll, rendered.selectedLine - Math.floor(height / 3)));
	return slice(start, windowAt(rendered.lines, start, height));
}

/** Top-pad a parallel row array the way fitLines pads lines. */
function padStart<T>(rows: T[], height: number): T[] {
	const result = rows.slice(-height);
	while (result.length < height) {
		result.unshift(undefined as T);
	}
	return result;
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
): { lines: string[]; tabSpans: InspectorTabSpan[] } {
	const view = inspector.view ?? "summary";
	const views = availableInspectorViews(inspector.tool, renderer);
	const prefix = " ".repeat(GUTTER);
	const tabSpans: InspectorTabSpan[] = [];
	let column = GUTTER;
	const tabs = views
		.map((item) => {
			const label = item === view ? item.toUpperCase() : item;
			tabSpans.push({ col0: column, col1: column + label.length, view: item });
			column += label.length + 2;
			return label;
		})
		.join("  ");
	const contentWidth = Math.max(1, width - visibleWidth(prefix));
	const maxRows = detailRowLimit(width, height);
	const detail = detailLines(inspector.tool, view, renderer)
		.flatMap((line) => wrap(clean(line), contentWidth))
		.slice(inspector.scrollOffset ?? 0, (inspector.scrollOffset ?? 0) + maxRows);
	const statusTone: Tone =
		inspector.tool.state === "running" ? "accent" : inspector.tool.state === "success" ? "success" : "error";
	const marker = inspector.tool.state === "running" ? "RUNNING" : inspector.tool.state === "success" ? "DONE" : "FAIL";
	return {
		lines: [
			paint("accent", `${prefix}${tabs}`),
			paint(statusTone, `${prefix}${marker} ${g.dot} ${inspector.tool.toolName}`),
			...detail.map((line) => `${paint("muted", prefix)}${line}`),
		],
		tabSpans,
	};
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
