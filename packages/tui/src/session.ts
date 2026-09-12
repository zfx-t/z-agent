import { DEFAULT_COMPLETION_ROWS, rankSlashCompletions, slashCompletionToken } from "./completion.ts";
import type { ConfirmChoice, ConfirmRequest } from "./confirm.ts";
import { confirmChoiceFromKey } from "./confirm.ts";
import { EditorBuffer } from "./editor.ts";
import type { TuiAction } from "./keymap.ts";
import { type ParsedKeymap, parseKeymapConfig, resolveAction } from "./keymap.ts";
import { type Key, type MouseEventInfo, parseInputChunk } from "./keys.ts";
import type { TuiEntryCache, TuiFrameState, TuiHitRegion } from "./layout.ts";
import { CONFIRM_ORDER, renderFrameEx, transcriptViewportFor } from "./layout.ts";
import type {
	TuiCompletionCandidate,
	TuiCompletionState,
	TuiFocus,
	TuiHeaderState,
	TuiInspectorState,
	TuiInspectorView,
	TuiToolRenderer,
	TuiToolSnapshot,
	TuiToolUpdate,
	TuiTranscriptEntry,
} from "./model.ts";
import { LineScreen } from "./screen.ts";
import { defaultScrollConfig, MouseScrollState, type ScrollDirection } from "./scroll.ts";
import { reportAmbiguousWide } from "./text.ts";
import { availableInspectorViews, detailLines } from "./tool-detail.ts";

export interface InteractiveTuiOptions {
	stdin?: NodeJS.ReadStream;
	stdout?: NodeJS.WriteStream;
	columns?: number;
	rows?: number;
	/** Defaults to terminal color support unless NO_COLOR is set. */
	colors?: boolean;
	status?: () => string;
	header?: () => TuiHeaderState;
	/** Called for input submitted while an agent run is active. */
	onSubmitDuringRun?: (value: string) => void;
	/** Ctrl+C while streaming (raw mode swallows SIGINT). */
	onInterrupt?: () => void;
	/** Supplies current built-in and skill slash candidates without invoking them. */
	completionCandidates?: () => readonly TuiCompletionCandidate[];
	/** Command palette rows. Defaults to completionCandidates. */
	paletteCandidates?: () => readonly TuiCompletionCandidate[];
	/** Parsed keymap. Interrupt remains ctrl+c. */
	keymap?: ParsedKeymap;
	/** Optional per-tool inspector renderer. Failures fall back to the default views. */
	toolRenderer?: TuiToolRenderer;
	/** Maximum visible completion rows. Defaults to 6. */
	completionRows?: number;
	/** Braille spinner + fast elapsed ticks. Defaults on; Z_AGENT_MOTION=off|0 disables. */
	motion?: boolean;
	/** Mouse wheel scrolls the transcript (moves picker selection). Z_AGENT_MOUSE=off|0 disables reporting. */
	mouse?: boolean;
	/** Chrome glyph set; "auto" uses ascii under CJK/ambiguous-width terminals. Z_AGENT_GLYPHS overrides. */
	glyphs?: "unicode" | "ascii" | "auto";
}

export interface PickListOptions {
	/** Value returned on Esc / Ctrl+C. Default 0. */
	cancelValue?: number;
	/** Initially highlighted item index. Default 0. */
	initialIndex?: number;
}

const MAX_PROMPT_HISTORY = 100;
/** Double-Esc arming window (Grok: ESC_DOUBLE_PRESS_TTL). */
const ESC_DOUBLE_PRESS_MS = 800;

/**
 * Full-screen coding TUI: transcript, streaming deltas, editor, confirm modal.
 */
export class InteractiveTui {
	private readonly stdin: NodeJS.ReadStream;
	private readonly stdout: NodeJS.WriteStream;
	private readonly screen: LineScreen;
	private readonly editor = new EditorBuffer();
	private readonly transcript: TuiTranscriptEntry[] = [];
	private readonly promptHistory: string[] = [];
	private readonly statusFn: () => string;
	private readonly headerFn?: () => TuiHeaderState;
	private readonly onSubmitDuringRun?: (value: string) => void;
	private readonly completionCandidates?: () => readonly TuiCompletionCandidate[];
	private readonly paletteCandidates?: () => readonly TuiCompletionCandidate[];
	private readonly keymap: ParsedKeymap;
	private readonly toolRenderer?: TuiToolRenderer;
	private readonly completionRows: number;
	private readonly fixedColumns?: number;
	private readonly fixedRows?: number;
	private readonly colors: boolean;
	private streaming = false;
	private focus: TuiFocus = "editor";
	private selectedEntryId: string | undefined;
	private expandedToolCallId: string | undefined;
	private inspectorView: TuiInspectorView = "summary";
	private inspectorScrollOffset = 0;
	private followingLatest = true;
	private unseenEventCount = 0;
	/** First visible transcript row while scrolled back; undefined = follow latest. */
	private transcriptScrollOffset: number | undefined;
	/** Hit regions from the last painted frame; mouse presses resolve against these. */
	private lastHits: TuiHitRegion[] = [];
	/** Transcript viewport height of the last painted frame (wheel scroll basis). */
	private lastBodyHeight = 0;
	/** Cell of the last left-button press; a release on the same cell is a click. */
	private mouseDownCell: { col: number; row: number } | undefined;
	private readonly scrollState = new MouseScrollState();
	private scrollTimer: NodeJS.Timeout | undefined;
	/** Zone the active wheel gesture scrolls (recomputed per event from the pointer cell). */
	private scrollZone: "picker" | "inspector" | "transcript" = "transcript";
	private confirm: { request: ConfirmRequest; resolve: (choice: ConfirmChoice) => void } | undefined;
	private confirmFocused: ConfirmChoice = "once";
	/** Armed double-Esc gesture: "clear" wipes the draft to stash, "rewind" opens /sessions. */
	private escArm: { kind: "clear" | "rewind"; timer: NodeJS.Timeout } | undefined;
	/** Draft parked by Ctrl+S or Esc Esc. `discard` = user meant it gone (never auto-restores). */
	private draftStash: { text: string; discard: boolean } | undefined;
	/** One-shot hint shown in place of the key hints until the next keypress. */
	private transientHint: string | undefined;
	private picker:
		| {
				title: string;
				items: string[];
				matches: number[];
				index: number;
				query: string;
				cancelValue: number;
				resolve: (index: number) => void;
		  }
		| undefined;
	private promptResolve: ((line: string | null) => void) | undefined;
	private readonly pendingPrompts: string[] = [];
	private completion: TuiCompletionState | undefined;
	private completionAccepted = false;
	private historyIndex: number | undefined;
	private historyDraft = "";
	private closed = false;
	private started = false;
	private readonly onInterrupt?: () => void;
	private readonly onData: (chunk: Buffer) => void;
	private readonly onResize: () => void;
	private nextEntryId = 0;
	private pendingInput = "";
	private runStartedAt: number | undefined;
	private tickCount = 0;
	private ticker: NodeJS.Timeout | undefined;
	private readonly motion: boolean;
	private readonly mouse: boolean;
	private readonly glyphTheme: "unicode" | "ascii" | undefined;
	private readonly entryCache: TuiEntryCache = new WeakMap();
	private probePending = false;
	private probeTimer: NodeJS.Timeout | undefined;

	constructor(options: InteractiveTuiOptions = {}) {
		this.stdin = options.stdin ?? process.stdin;
		this.stdout = options.stdout ?? process.stdout;
		this.mouse = options.mouse ?? (process.env.Z_AGENT_MOUSE !== "off" && process.env.Z_AGENT_MOUSE !== "0");
		this.screen = new LineScreen(
			(chunk) => {
				this.stdout.write(chunk);
			},
			{ mouse: this.mouse },
		);
		this.statusFn = options.status ?? (() => "z-agent");
		this.headerFn = options.header;
		this.onSubmitDuringRun = options.onSubmitDuringRun;
		this.completionCandidates = options.completionCandidates;
		this.paletteCandidates = options.paletteCandidates;
		this.keymap = options.keymap ?? parseKeymapConfig(undefined);
		this.toolRenderer = options.toolRenderer;
		this.completionRows = completionRowCount(options.completionRows);
		this.fixedColumns = options.columns;
		this.fixedRows = options.rows;
		this.colors = options.colors ?? (this.stdout.isTTY === true && process.env.NO_COLOR === undefined);
		this.motion = options.motion ?? (process.env.Z_AGENT_MOTION !== "off" && process.env.Z_AGENT_MOTION !== "0");
		this.glyphTheme = resolveGlyphTheme(options.glyphs);
		this.onInterrupt = options.onInterrupt;
		this.onData = (chunk) => {
			this.handleInput(chunk.toString("utf-8"));
		};
		this.onResize = () => {
			this.repaint();
		};
	}

	start(): void {
		if (this.started) {
			this.repaint();
			return;
		}
		this.started = true;
		this.screen.enter();
		if (this.stdin.isTTY && typeof this.stdin.setRawMode === "function") {
			this.stdin.setRawMode(true);
		}
		this.stdin.on("data", this.onData);
		if (this.stdout.isTTY) {
			this.stdout.on("resize", this.onResize);
		}
		this.probeAmbiguousWidth();
		this.repaint();
	}

	/**
	 * Measure the terminal's ambiguous-glyph width once: print "─" on the alt
	 * screen and read the DSR cursor-column report (2 = single, 3 = double).
	 * Only meaningful on the real process streams — injected test streams can
	 * never answer.
	 */
	private probeAmbiguousWidth(): void {
		if (
			process.env.Z_AGENT_AMBIGUOUS !== undefined ||
			this.stdin !== process.stdin ||
			this.stdout !== process.stdout
		) {
			return;
		}
		this.probePending = true;
		this.probeTimer = setTimeout(() => {
			this.resolveAmbiguousProbe(undefined);
		}, 150);
		this.probeTimer.unref?.();
		this.stdout.write("─\x1b[6n");
	}

	private resolveAmbiguousProbe(wide: boolean | undefined): void {
		if (!this.probePending) {
			return;
		}
		this.probePending = false;
		if (this.probeTimer) {
			clearTimeout(this.probeTimer);
			this.probeTimer = undefined;
		}
		if (wide !== undefined) {
			reportAmbiguousWide(wide);
		}
		this.stdout.write("\r\x1b[2K");
		const buffered = this.pendingInput;
		this.pendingInput = "";
		this.repaint();
		if (buffered.length > 0) {
			this.dispatchInput(buffered);
		}
	}

	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		if (this.ticker) {
			clearInterval(this.ticker);
			this.ticker = undefined;
		}
		if (this.probeTimer) {
			clearTimeout(this.probeTimer);
			this.probeTimer = undefined;
		}
		this.probePending = false;
		if (this.scrollTimer) {
			clearTimeout(this.scrollTimer);
			this.scrollTimer = undefined;
		}
		this.disarmEsc();
		this.stdin.off("data", this.onData);
		if (this.stdout.isTTY) {
			this.stdout.off("resize", this.onResize);
		}
		if (this.stdin.isTTY && typeof this.stdin.setRawMode === "function") {
			this.stdin.setRawMode(false);
		}
		this.stdin.pause?.();
		this.screen.leave();
		this.promptResolve?.(null);
		this.confirm?.resolve("deny");
		this.picker?.resolve(this.picker.cancelValue);
	}

	setStreaming(value: boolean): void {
		if (value && !this.streaming) {
			this.runStartedAt = Date.now();
		}
		this.streaming = value;
		this.syncTicker();
		this.repaint();
	}

	appendAssistantDelta(delta: string): void {
		this.recordIncomingEvent();
		const last = this.transcript[this.transcript.length - 1];
		if (!last || last.kind !== "assistant") {
			this.transcript.push(this.entry("assistant", delta));
		} else {
			last.text += delta;
		}
		this.repaint();
	}

	appendLine(line: string): void {
		this.transcript.push(this.entry("info", line));
		this.repaint();
	}

	appendNotice(kind: "warning" | "error", text: string): void {
		this.recordIncomingEvent();
		this.transcript.push(this.entry(kind, text));
		this.repaint();
	}

	appendUser(text: string, queued = this.streaming): void {
		const entry = this.entry("user", text);
		entry.queued = queued;
		this.transcript.push(entry);
		this.repaint();
	}

	clearTranscript(): void {
		this.transcript.length = 0;
		this.transcriptScrollOffset = undefined;
		this.selectedEntryId = undefined;
		this.expandedToolCallId = undefined;
		this.followingLatest = true;
		this.unseenEventCount = 0;
		this.repaint();
	}

	showStatus(): void {
		this.appendLine(`[status] ${this.statusFn()}`);
	}

	appendToolStart(toolCallId: string, toolName: string, args: unknown): void {
		this.recordIncomingEvent();
		const tool: TuiToolSnapshot = {
			toolCallId,
			toolName,
			input: args,
			argsText: compactJson(args, 180),
			state: "running",
			startedAt: Date.now(),
		};
		this.transcript.push(this.entry("tool", `${toolName} ${tool.argsText}`, tool));
		this.syncTicker();
		this.repaint();
	}

	appendToolUpdate(toolCallId: string, update: TuiToolUpdate): void {
		const entry = this.findTool(toolCallId);
		if (!entry?.tool) {
			return;
		}
		this.recordIncomingEvent();
		Object.assign(entry.tool, update);
		this.repaint();
	}

	appendToolEnd(toolCallId: string, output: string, isError: boolean, detailsText?: string): void {
		const entry = this.findTool(toolCallId);
		if (!entry?.tool) {
			return;
		}
		this.recordIncomingEvent();
		entry.tool.state = isError ? "error" : "success";
		entry.tool.outputText = output.trim();
		entry.tool.detailsText = detailsText;
		const startedAt = entry.tool.startedAt ?? Date.now();
		entry.tool.durationMs = Math.max(0, Date.now() - startedAt);
		this.syncTicker();
		this.repaint();
	}

	toggleLastThinking(): void {
		let last: TuiTranscriptEntry | undefined;
		for (let i = this.transcript.length - 1; i >= 0; i--) {
			if (this.transcript[i]?.kind === "thinking") {
				last = this.transcript[i];
				break;
			}
		}
		if (!last) {
			return;
		}
		last.hidden = !last.hidden;
		this.repaint();
	}

	appendThinkingDelta(delta: string): void {
		this.recordIncomingEvent();
		const last = this.transcript[this.transcript.length - 1];
		if (!last || last.kind !== "thinking") {
			this.transcript.push(this.entry("thinking", delta));
		} else if (!last.hidden) {
			last.text += delta;
		}
		this.repaint();
	}

	pasteText(text: string): void {
		this.resetHistoryNavigation();
		this.editor.insertPastedText(text, `[Pasted text - ${formatBytes(text.length)}]`);
		this.updateCompletion();
		this.repaint();
	}

	pasteImage(label = "[Image - pasted]"): void {
		this.resetHistoryNavigation();
		this.editor.insertPastedImage(label);
		this.repaint();
	}

	confirmTool(toolName: string, args: unknown): Promise<ConfirmChoice> {
		return new Promise((resolve) => {
			this.cancelCompletion();
			this.confirmFocused = "once";
			this.confirm = { request: { toolName, args }, resolve };
			this.repaint();
		});
	}

	pickFromList(title: string, items: string[], options: PickListOptions = {}): Promise<number> {
		return new Promise((resolve) => {
			this.cancelCompletion();
			const initial = options.initialIndex;
			this.picker = {
				title,
				items,
				matches: items.map((_, index) => index),
				index:
					initial !== undefined && Number.isFinite(initial)
						? Math.max(0, Math.min(items.length - 1, Math.trunc(initial)))
						: 0,
				query: "",
				cancelValue: options.cancelValue ?? 0,
				resolve,
			};
			this.repaint();
		});
	}

	readPrompt(): Promise<string | null> {
		if (this.closed) {
			return Promise.resolve(null);
		}
		return new Promise((resolve) => {
			if (this.closed) {
				resolve(null);
				return;
			}
			const pending = this.pendingPrompts.shift();
			if (pending !== undefined) {
				queueMicrotask(() => resolve(pending));
				return;
			}
			this.promptResolve = resolve;
			this.repaint();
		});
	}

	/** Test helper: feed a parsed key. */
	pushKey(key: Key): void {
		this.dispatch(key);
	}

	/** Re-read candidates after an external registry refresh. */
	refreshCompletions(): void {
		this.updateCompletion();
		this.repaint();
	}

	private handleInput(raw: string): void {
		const input = `${this.pendingInput}${raw}`;
		this.pendingInput = "";
		if (this.probePending) {
			const report = DSR_REPORT.exec(input);
			if (report === null) {
				if (input.length >= 256) {
					this.resolveAmbiguousProbe(undefined);
				} else {
					this.pendingInput = input;
					return;
				}
			} else {
				this.resolveAmbiguousProbe(Number(report[1]) === 3);
				const rest = input.slice(0, report.index) + input.slice(report.index + report[0].length);
				if (rest.length === 0) {
					return;
				}
				this.dispatchInput(rest);
				return;
			}
		}
		this.dispatchInput(input);
	}

	private dispatchInput(input: string): void {
		const parsed = parseInputChunk(input);
		this.pendingInput = parsed.remainder;
		for (const key of parsed.keys) {
			this.dispatch(key);
		}
	}

	private dispatch(key: Key): void {
		if (this.closed) {
			return;
		}
		if (key.type === "report") {
			return;
		}
		// Any non-Esc input — keypress, click, or wheel — retires an armed
		// double-Esc gesture and its hint.
		if (key.type !== "escape") {
			this.transientHint = undefined;
			this.disarmEsc();
		}
		if (key.type === "mouse") {
			this.dispatchMouse(key.event);
			return;
		}
		if (key.type === "wheelUp" || key.type === "wheelDown") {
			this.handleWheel(key);
			return;
		}
		if (this.picker) {
			if (key.type === "up" || key.type === "shiftTab") {
				this.picker.index =
					(this.picker.index - 1 + this.picker.matches.length) % Math.max(1, this.picker.matches.length);
			} else if (key.type === "down" || key.type === "tab") {
				this.picker.index = (this.picker.index + 1) % Math.max(1, this.picker.matches.length);
			} else if (key.type === "pageUp") {
				this.picker.index = Math.max(0, this.picker.index - 5);
			} else if (key.type === "pageDown") {
				this.picker.index = Math.min(this.picker.matches.length - 1, this.picker.index + 5);
			} else if (key.type === "enter" || key.type === "ctrlEnter") {
				this.finishPickerMatch();
				return;
			} else if (key.type === "escape" || (key.type === "ctrl" && key.value === "c")) {
				this.finishPicker(this.picker.cancelValue);
				return;
			} else if (key.type === "backspace") {
				this.picker.query = this.picker.query.slice(0, -1);
				this.filterPicker();
			} else if (key.type === "ctrl" && key.value === "u") {
				this.picker.query = "";
				this.filterPicker();
			} else if (key.type === "char") {
				if (this.picker.query.length === 0 && key.value.length === 1 && key.value >= "1" && key.value <= "9") {
					const index = Number(key.value) - 1;
					if (index < this.picker.matches.length) {
						this.picker.index = index;
						this.finishPickerMatch();
						return;
					}
				}
				this.picker.query += key.value;
				this.filterPicker();
			}
			this.repaint();
			return;
		}
		const action = resolveAction(key, this.keymap.bindings, {
			completion: this.completion !== undefined && this.focus === "editor",
			focus: this.focus,
			modal: this.confirm !== undefined,
			streaming: this.streaming,
		});
		if (key.type === "ctrl" && key.value === "t") {
			this.toggleLastThinking();
			return;
		}
		if (action === "interrupt") {
			this.appendNotice("warning", "abort requested");
			this.onInterrupt?.();
			return;
		}
		if (action === "exit") {
			this.promptResolve?.(null);
			this.promptResolve = undefined;
			return;
		}
		if (this.confirm) {
			if (
				key.type === "left" ||
				key.type === "up" ||
				key.type === "shiftTab" ||
				(key.type === "ctrl" && key.value === "p")
			) {
				this.moveConfirmFocus(-1);
				this.repaint();
				return;
			}
			if (
				key.type === "right" ||
				key.type === "down" ||
				key.type === "tab" ||
				(key.type === "ctrl" && key.value === "n")
			) {
				this.moveConfirmFocus(1);
				this.repaint();
				return;
			}
			if (key.type === "char" && /^[1-3]$/u.test(key.value)) {
				this.resolveConfirm(CONFIRM_ORDER[Number(key.value) - 1] ?? "deny");
				return;
			}
			if (key.type === "enter" || key.type === "ctrlEnter") {
				this.resolveConfirm(this.confirmFocused);
				return;
			}
			const choice = confirmChoiceFromKey(key);
			if (choice) {
				this.resolveConfirm(choice);
				return;
			}
			this.repaint();
			return;
		}
		if (
			this.focus === "editor" &&
			(action === "completion.accept" || action === "completion.next" || action === "completion.prev")
		) {
			this.dispatchCompletionKey(action === "completion.prev" ? { type: "shiftTab" } : { type: "tab" });
			this.repaint();
			return;
		}
		if (this.focus === "editor" && this.dispatchCompletionKey(key)) {
			this.repaint();
			return;
		}
		if (action === "focus.transcript") {
			this.toggleFocus();
			this.repaint();
			return;
		}
		if (key.type === "escape" && this.focus === "editor") {
			this.handleEditorEscape();
			return;
		}
		if (action === "focus.editor") {
			this.cancelCompletion();
			this.focus = "editor";
			this.repaint();
			return;
		}
		if (action === "palette" && this.editor.value.length === 0) {
			void this.openPalette();
			return;
		}
		// PageUp/PageDown scroll the transcript without stealing editor focus
		// (Grok: prompt stays focused, the draft is untouched).
		if (this.focus === "editor" && (key.type === "pageUp" || key.type === "pageDown")) {
			this.scrollTranscript(key.type === "pageUp" ? -this.scrollPage() : this.scrollPage());
			this.repaint();
			return;
		}
		if (this.focus === "transcript") {
			if (action) {
				this.dispatchTranscriptAction(action, key);
				return;
			}
			this.dispatchTranscriptKey(key);
			return;
		}
		if (action === "newline") {
			key = { type: "newline" };
		} else if (action === "submit") {
			key = { type: "enter" };
		}
		if (key.type === "ctrl" && key.value === "s") {
			this.toggleDraftStash();
			this.repaint();
			return;
		}
		let refreshCompletion = false;
		if (key.type === "paste") {
			this.resetHistoryNavigation();
			this.editor.insertPastedText(key.value, `[Pasted text - ${formatBytes(key.value.length)}]`);
			refreshCompletion = true;
		} else if (key.type === "char") {
			this.resetHistoryNavigation();
			this.editor.insert(key.value);
			refreshCompletion = true;
		} else if (key.type === "backspace") {
			this.resetHistoryNavigation();
			this.editor.backspace();
			refreshCompletion = true;
		} else if (key.type === "delete") {
			this.resetHistoryNavigation();
			this.editor.delete();
			refreshCompletion = true;
		} else if (key.type === "left") {
			this.editor.moveLeft();
			refreshCompletion = true;
		} else if (key.type === "right") {
			this.editor.moveRight();
			refreshCompletion = true;
		} else if (key.type === "selectLeft") {
			this.editor.extendLeft();
		} else if (key.type === "selectRight") {
			this.editor.extendRight();
		} else if (key.type === "selectUp") {
			this.editor.extendUp();
		} else if (key.type === "selectDown") {
			this.editor.extendDown();
		} else if (key.type === "selectWordLeft") {
			this.editor.extendWordLeft();
		} else if (key.type === "selectWordRight") {
			this.editor.extendWordRight();
		} else if (key.type === "selectHome") {
			this.editor.extendHome();
		} else if (key.type === "selectEnd") {
			this.editor.extendEnd();
		} else if (key.type === "wordLeft") {
			this.editor.moveWordLeft();
			refreshCompletion = true;
		} else if (key.type === "wordRight") {
			this.editor.moveWordRight();
			refreshCompletion = true;
		} else if (key.type === "deleteWordForward") {
			this.resetHistoryNavigation();
			this.editor.deleteWordForward();
			refreshCompletion = true;
		} else if (key.type === "deleteWordBack") {
			this.resetHistoryNavigation();
			this.editor.deleteWordBackward();
			refreshCompletion = true;
		} else if (key.type === "ctrl" && key.value === "k") {
			this.resetHistoryNavigation();
			this.editor.killToLineEnd();
			refreshCompletion = true;
		} else if (key.type === "home" || (key.type === "ctrl" && key.value === "a")) {
			this.editor.moveHome();
			refreshCompletion = true;
		} else if (key.type === "end" || (key.type === "ctrl" && key.value === "e")) {
			this.editor.moveEnd();
			refreshCompletion = true;
		} else if (key.type === "newline") {
			this.resetHistoryNavigation();
			this.editor.insert("\n");
			refreshCompletion = true;
		} else if (key.type === "up") {
			if (this.editor.isMultiline) {
				this.editor.moveUp();
			} else {
				this.recallPreviousPrompt();
			}
			refreshCompletion = true;
		} else if (key.type === "down") {
			if (this.editor.isMultiline) {
				this.editor.moveDown();
			} else {
				this.recallNextPrompt();
			}
			refreshCompletion = true;
		} else if (key.type === "ctrl" && key.value === "u") {
			this.resetHistoryNavigation();
			this.editor.clear();
			refreshCompletion = true;
		} else if (key.type === "ctrl" && key.value === "w") {
			this.resetHistoryNavigation();
			this.editor.deleteWordBackward();
			refreshCompletion = true;
		} else if (key.type === "enter" || key.type === "ctrlEnter") {
			if (this.streaming && !this.onSubmitDuringRun) {
				this.repaint();
				return;
			}
			this.cancelCompletion();
			const value = this.editor.submit().trim();
			if (value.length === 0) {
				this.repaint();
				return;
			}
			this.rememberPrompt(value);
			this.appendUser(value);
			this.followTranscriptLatest();
			// A Ctrl+S-stashed draft returns after the next send; a draft cleared
			// via Esc Esc (discard gesture) stays parked until Ctrl+S restores it.
			if (this.draftStash && !this.draftStash.discard) {
				this.editor.set(this.draftStash.text);
				this.draftStash = undefined;
			}
			if (this.streaming) {
				this.onSubmitDuringRun?.(value);
			} else {
				const resolve = this.promptResolve;
				this.promptResolve = undefined;
				if (resolve) {
					resolve(value);
				} else {
					this.pendingPrompts.push(value);
				}
			}
		}
		if (refreshCompletion) {
			this.updateCompletion();
		}
		this.repaint();
	}

	private dispatchCompletionKey(key: Key): boolean {
		if (!this.completion) {
			return false;
		}
		if (key.type === "escape") {
			this.cancelCompletion();
			return true;
		}
		if (key.type !== "tab" && key.type !== "shiftTab" && key.type !== "up" && key.type !== "down") {
			return false;
		}
		let index = this.completion.index;
		if (key.type === "up" || key.type === "down") {
			const direction = key.type === "down" ? 1 : -1;
			index = (index + direction + this.completion.items.length) % this.completion.items.length;
		} else if (this.completionAccepted || key.type === "shiftTab") {
			const direction = key.type === "shiftTab" ? -1 : 1;
			index = (index + direction + this.completion.items.length) % this.completion.items.length;
		}
		const candidate = this.completion.items[index];
		if (!candidate) {
			this.cancelCompletion();
			return true;
		}
		this.resetHistoryNavigation();
		this.editor.replaceRange(this.completion.tokenStart, this.completion.tokenEnd, candidate.token);
		this.completion = {
			...this.completion,
			index,
			tokenEnd: this.completion.tokenStart + candidate.token.length,
		};
		this.completionAccepted = true;
		return true;
	}

	private updateCompletion(): void {
		this.completionAccepted = false;
		const range = slashCompletionToken(this.editor.value, this.editor.cursorOffset);
		if (!range || !this.completionCandidates || this.focus !== "editor") {
			this.completion = undefined;
			return;
		}
		const candidates = this.completionCandidates();
		const items = rankSlashCompletions(candidates, range.query, candidates.length);
		this.completion =
			items.length === 0 ? undefined : { items, index: 0, tokenStart: range.start, tokenEnd: range.end };
	}

	private cancelCompletion(): void {
		this.completion = undefined;
		this.completionAccepted = false;
	}

	private toggleFocus(): void {
		this.cancelCompletion();
		if (this.focus === "transcript") {
			this.focus = "editor";
			return;
		}
		this.focus = "transcript";
		this.selectedEntryId = this.transcript.at(-1)?.id;
		this.transcriptScrollOffset = undefined;
		this.followingLatest = true;
		this.unseenEventCount = 0;
	}

	private async openPalette(): Promise<void> {
		const items = this.paletteCandidates?.() ?? this.completionCandidates?.() ?? [];
		if (items.length === 0) {
			const resolve = this.promptResolve;
			this.promptResolve = undefined;
			resolve?.("/commands");
			this.repaint();
			return;
		}
		const index = await this.pickFromList(
			"Commands",
			items.map((item) => `${item.token}  ${item.description}`),
			{ cancelValue: -1 },
		);
		if (index < 0) {
			return;
		}
		const token = items[index]?.token;
		if (!token) {
			return;
		}
		this.editor.set(`${token} `);
		this.focus = "editor";
		this.updateCompletion();
		this.repaint();
	}

	private dispatchTranscriptAction(action: TuiAction, key: Key): void {
		if (action === "inspector.toggle") {
			this.toggleInspector();
			this.repaint();
			return;
		}
		if (action === "inspector.next") {
			this.moveEntrySelection(1);
			this.repaint();
			return;
		}
		if (action === "inspector.prev") {
			this.moveEntrySelection(-1);
			this.repaint();
			return;
		}
		if (action === "inspector.view.next") {
			this.moveInspectorView(1);
			this.repaint();
			return;
		}
		if (action === "inspector.view.prev") {
			this.moveInspectorView(-1);
			this.repaint();
			return;
		}
		this.dispatchTranscriptKey(key);
	}

	private dispatchTranscriptKey(key: Key): void {
		if (key.type === "escape" || key.type === "tab" || key.type === "shiftTab") {
			this.focus = "editor";
			this.repaint();
			return;
		}
		// Grok simple mode: typing while the transcript is focused jumps back to
		// the prompt and delivers the keystroke there. `?` opens the palette.
		if (key.type === "char" || key.type === "paste") {
			if (key.type === "char" && key.value === "?" && this.editor.value.length === 0) {
				void this.openPalette();
				this.repaint();
				return;
			}
			this.focus = "editor";
			this.dispatch(key);
			return;
		}
		if (key.type === "up") {
			if (this.transcript.length > 0) {
				this.moveEntrySelection(-1);
			} else {
				this.scrollTranscript(-1);
			}
		} else if (key.type === "down") {
			if (this.transcript.length > 0) {
				this.moveEntrySelection(1);
			} else {
				this.scrollTranscript(1);
			}
		} else if (key.type === "enter" || key.type === "ctrlEnter") {
			this.toggleInspector();
		} else if (key.type === "left") {
			this.moveInspectorView(-1);
		} else if (key.type === "right") {
			this.moveInspectorView(1);
		} else if (key.type === "selectLeft") {
			this.moveTurnSelection(-1);
		} else if (key.type === "selectRight") {
			this.moveTurnSelection(1);
		} else if (key.type === "selectUp") {
			this.scrollTranscript(-1);
		} else if (key.type === "selectDown") {
			this.scrollTranscript(1);
		} else if (key.type === "ctrl" && key.value === "u") {
			this.scrollTranscript(-Math.max(1, Math.floor(this.scrollPage() / 2)));
		} else if (key.type === "ctrl" && key.value === "d") {
			this.scrollTranscript(Math.max(1, Math.floor(this.scrollPage() / 2)));
		} else if (key.type === "pageUp") {
			if (this.activeInspector()) {
				this.moveInspectorScroll(-6);
			} else {
				this.scrollTranscript(-this.scrollPage());
			}
		} else if (key.type === "pageDown") {
			if (this.activeInspector()) {
				this.moveInspectorScroll(6);
			} else {
				this.scrollTranscript(this.scrollPage());
			}
		} else if (key.type === "home") {
			if (this.activeInspector()) {
				this.inspectorScrollOffset = 0;
			} else {
				this.scrollTranscriptToTop();
			}
		} else if (key.type === "end") {
			if (this.activeInspector()) {
				this.inspectorScrollOffset = this.inspectorMaxScroll();
			} else {
				this.followTranscriptLatest();
			}
		}
		this.repaint();
	}

	private moveEntrySelection(direction: -1 | 1): void {
		if (this.transcript.length === 0) {
			return;
		}
		const current = this.transcript.findIndex((entry) => entry.id === this.selectedEntryId);
		const next =
			current < 0
				? direction < 0
					? this.transcript.length - 1
					: 0
				: Math.max(0, Math.min(this.transcript.length - 1, current + direction));
		this.selectedEntryId = this.transcript[next]?.id;
		this.transcriptScrollOffset = undefined;
		const isLatest = next === this.transcript.length - 1;
		this.followingLatest = isLatest;
		if (isLatest) {
			this.unseenEventCount = 0;
		}
	}

	/** Shift+←/→ jump to the previous/next user turn (Grok turn navigation). */
	private moveTurnSelection(direction: -1 | 1): void {
		const current = this.transcript.findIndex((entry) => entry.id === this.selectedEntryId);
		let index = current;
		while (true) {
			index += direction;
			if (index < 0 || index >= this.transcript.length) {
				// With no selection, land on the nearest turn in that direction.
				if (current >= 0) {
					return;
				}
				const fallback = direction < 0 ? this.lastTurnIndex() : this.firstTurnIndex();
				if (fallback === undefined) {
					return;
				}
				index = fallback;
			}
			if (this.transcript[index]?.kind === "user") {
				this.selectedEntryId = this.transcript[index]?.id;
				this.transcriptScrollOffset = undefined;
				this.followingLatest = index === this.transcript.length - 1;
				return;
			}
			if ((direction < 0 && index <= 0) || (direction > 0 && index >= this.transcript.length - 1)) {
				return;
			}
		}
	}

	private lastTurnIndex(): number | undefined {
		for (let index = this.transcript.length - 1; index >= 0; index -= 1) {
			if (this.transcript[index]?.kind === "user") {
				return index;
			}
		}
		return undefined;
	}

	private firstTurnIndex(): number | undefined {
		for (let index = 0; index < this.transcript.length; index += 1) {
			if (this.transcript[index]?.kind === "user") {
				return index;
			}
		}
		return undefined;
	}

	private scrollTranscript(delta: number): void {
		const { maxScroll, start } = transcriptViewportFor(this.frameState(), this.columns(), this.rows());
		const current = this.transcriptScrollOffset ?? start;
		const next = Math.max(0, Math.min(maxScroll, current + delta));
		if (next >= maxScroll) {
			this.followTranscriptLatest();
		} else {
			this.transcriptScrollOffset = next;
			this.followingLatest = false;
		}
	}

	private scrollTranscriptToTop(): void {
		this.transcriptScrollOffset = 0;
		this.followingLatest = false;
	}

	private followTranscriptLatest(): void {
		this.transcriptScrollOffset = undefined;
		this.followingLatest = true;
		this.unseenEventCount = 0;
	}

	/**
	 * Esc in the editor pane (Grok policy): never cancels a run, drops an open
	 * selection, arms a double-press clear for a non-empty draft, or a rewind
	 * (sessions picker) on an empty draft with prior turns.
	 */
	private handleEditorEscape(): void {
		if (this.editor.selectionRange) {
			this.editor.clearSelection();
			this.disarmEsc();
			this.repaint();
			return;
		}
		if (this.streaming) {
			this.disarmEsc();
			this.transientHint = "ctrl+c interrupts the run";
			this.repaint();
			return;
		}
		if (this.editor.value.length > 0) {
			if (this.escArm?.kind === "clear") {
				this.disarmEsc();
				this.stashDraft(true);
				this.transientHint = "draft stashed · ctrl+s restores";
			} else {
				this.armEsc("clear");
				this.transientHint = "esc again: clear draft";
			}
			this.repaint();
			return;
		}
		if (this.transcript.some((entry) => entry.kind === "user")) {
			if (this.escArm?.kind === "rewind") {
				this.disarmEsc();
				// Rewind surface: resolve the pending prompt with the sessions
				// command, exactly as the palette fallback resolves /commands.
				const resolve = this.promptResolve;
				this.promptResolve = undefined;
				if (resolve) {
					resolve("/sessions");
				} else {
					this.pendingPrompts.push("/sessions");
				}
				this.repaint();
				return;
			}
			this.armEsc("rewind");
			this.transientHint = "esc again: sessions";
			this.repaint();
			return;
		}
		this.disarmEsc();
		this.repaint();
	}

	private armEsc(kind: "clear" | "rewind"): void {
		this.disarmEsc();
		const timer = setTimeout(() => {
			if (this.escArm?.timer !== timer) {
				return;
			}
			this.escArm = undefined;
			if (this.transientHint !== undefined) {
				this.transientHint = undefined;
				this.repaint();
			}
		}, ESC_DOUBLE_PRESS_MS);
		timer.unref?.();
		this.escArm = { kind, timer };
	}

	private disarmEsc(): void {
		if (this.escArm) {
			clearTimeout(this.escArm.timer);
			this.escArm = undefined;
		}
	}

	/** Ctrl+S: park the draft (stash) or restore the parked draft on an empty prompt. */
	private toggleDraftStash(): void {
		if (this.editor.value.length > 0) {
			this.stashDraft(false);
			this.transientHint = "draft stashed · ctrl+s restores";
			return;
		}
		if (this.draftStash) {
			this.editor.set(this.draftStash.text);
			this.draftStash = undefined;
			this.resetHistoryNavigation();
		}
	}

	private stashDraft(discard: boolean): void {
		const text = this.editor.value;
		if (text.length === 0) {
			return;
		}
		this.draftStash = { text, discard };
		this.rememberPrompt(text);
		this.editor.clear();
		this.resetHistoryNavigation();
		this.updateCompletion();
	}

	private resolveConfirm(choice: ConfirmChoice): void {
		const confirm = this.confirm;
		this.confirm = undefined;
		confirm?.resolve(choice);
		this.repaint();
	}

	private moveConfirmFocus(direction: -1 | 1): void {
		const index = CONFIRM_ORDER.indexOf(this.confirmFocused);
		const next = (index + direction + CONFIRM_ORDER.length) % CONFIRM_ORDER.length;
		this.confirmFocused = CONFIRM_ORDER[next] ?? "once";
	}

	/** Wheel event → normalized scroll stream (Grok MouseScrollState). */
	private handleWheel(key: { col?: number; row?: number; type: "wheelUp" | "wheelDown" }): void {
		const direction: ScrollDirection = key.type === "wheelUp" ? "up" : "down";
		let zone: "picker" | "inspector" | "transcript" = "transcript";
		if (this.picker) {
			zone = "picker";
		} else if (key.col !== undefined && key.row !== undefined) {
			const hit = this.lastHits.find(
				(h) => h.row === key.row && key.col !== undefined && key.col >= h.col0 && key.col < h.col1,
			);
			if (hit?.target.kind === "inspectorBody" || hit?.target.kind === "inspectorTab") {
				zone = "inspector";
			}
		}
		this.scrollZone = zone;
		const config = defaultScrollConfig(process.env, this.transcriptBodyHeight());
		const update = this.scrollState.onScroll(direction, config);
		if (update.lines !== 0) {
			this.applyScrollLines(update.lines);
		}
		this.scheduleScrollTick(update.nextTickMs);
		this.repaint();
	}

	private applyScrollLines(lines: number): void {
		if (this.scrollZone === "picker" && this.picker) {
			const last = Math.max(0, this.picker.matches.length - 1);
			this.picker.index = Math.max(0, Math.min(last, this.picker.index + lines));
			return;
		}
		if (this.scrollZone === "inspector" && this.activeInspector()) {
			this.moveInspectorScroll(lines);
			return;
		}
		this.scrollTranscript(lines);
	}

	/** Coalesced redraw cadence: the scroll stream flushes residual lines on a timer. */
	private scheduleScrollTick(nextTickMs: number | undefined): void {
		if (this.scrollTimer) {
			clearTimeout(this.scrollTimer);
			this.scrollTimer = undefined;
		}
		if (nextTickMs === undefined || this.closed) {
			return;
		}
		this.scrollTimer = setTimeout(
			() => {
				this.scrollTimer = undefined;
				const update = this.scrollState.onTick();
				if (update.lines !== 0) {
					this.applyScrollLines(update.lines);
				}
				this.scheduleScrollTick(update.nextTickMs);
				this.repaint();
			},
			Math.max(1, nextTickMs),
		);
		this.scrollTimer.unref?.();
	}

	private transcriptBodyHeight(): number {
		if (this.lastBodyHeight > 0) {
			return this.lastBodyHeight;
		}
		return transcriptViewportFor(this.frameState(), this.columns(), this.rows()).bodyHeight;
	}

	/**
	 * Click routing over the last frame's hit regions. A left-button release on
	 * the press cell is a click; movement becomes a drag (reserved for text
	 * selection — Shift-held clicks stay with the terminal's native select).
	 */
	private dispatchMouse(event: MouseEventInfo): void {
		if (event.kind === "drag") {
			return;
		}
		if (event.kind === "down") {
			this.mouseDownCell = event.button === "left" ? { col: event.col, row: event.row } : undefined;
			return;
		}
		const down = this.mouseDownCell;
		this.mouseDownCell = undefined;
		if (event.button !== "left" || !down || down.col !== event.col || down.row !== event.row) {
			return;
		}
		const region = this.lastHits.find(
			(hit) => event.row === hit.row && event.col >= hit.col0 && event.col < hit.col1,
		);
		if (!region) {
			if (!this.picker && !this.confirm && event.row >= 2 && event.row < 2 + this.transcriptBodyHeight()) {
				this.focus = "transcript";
				this.repaint();
			}
			return;
		}
		const target = region.target;
		if (this.picker) {
			if (target.kind === "picker") {
				this.picker.index = target.index;
				this.finishPickerMatch();
			}
			return;
		}
		if (this.confirm) {
			if (target.kind === "confirm") {
				this.resolveConfirm(target.choice);
			}
			return;
		}
		switch (target.kind) {
			case "editor": {
				this.focus = "editor";
				this.cancelCompletion();
				const cellIndex = event.col - region.col0;
				const charCol =
					cellIndex >= target.cells.length
						? target.charEnd
						: (target.cells[Math.max(0, cellIndex)] ?? target.charEnd);
				this.editor.setCursorFromDisplay(target.displayRow, charCol, event.shift);
				this.updateCompletion();
				break;
			}
			case "entry":
				this.clickEntry(target.entryId);
				break;
			case "inspectorBody":
				this.focus = "transcript";
				this.pinTranscriptViewport();
				this.selectedEntryId = target.entryId;
				break;
			case "inspectorTab": {
				const entry = this.transcript.find((item) => item.id === target.entryId);
				const toolCallId = entry?.tool?.toolCallId;
				if (toolCallId !== undefined) {
					this.focus = "transcript";
					this.pinTranscriptViewport();
					this.selectedEntryId = target.entryId;
					this.expandedToolCallId = toolCallId;
					this.inspectorView = target.view;
					this.inspectorScrollOffset = 0;
				}
				break;
			}
			case "followLatest":
				this.followTranscriptLatest();
				break;
		}
		this.repaint();
	}

	/**
	 * Freeze the transcript viewport at its current top row for a mouse
	 * selection: the clicked row is already under the pointer, and pinning
	 * keeps it there (a re-anchor or follow tail would slide other rows into
	 * the cell). The "scrolled" affordance still offers End back to latest.
	 */
	private pinTranscriptViewport(): void {
		if (this.transcriptScrollOffset !== undefined) {
			return;
		}
		const { start, maxScroll } = transcriptViewportFor(this.frameState(), this.columns(), this.rows());
		if (maxScroll <= 0) {
			return;
		}
		this.transcriptScrollOffset = start;
		this.followingLatest = false;
	}

	/** Click a transcript row: focus + select; a second click on a tool toggles its inspector. */
	private clickEntry(entryId: string): void {
		this.focus = "transcript";
		this.cancelCompletion();
		if (this.selectedEntryId === entryId) {
			const entry = this.transcript.find((item) => item.id === entryId);
			if (entry?.tool) {
				this.toggleInspector();
			}
			return;
		}
		// The row is already under the pointer — keep the viewport put so a
		// second click on the same cell still hits this entry.
		this.pinTranscriptViewport();
		this.selectedEntryId = entryId;
	}

	private scrollPage(): number {
		const { bodyHeight } = transcriptViewportFor(this.frameState(), this.columns(), this.rows());
		return Math.max(1, bodyHeight - 3);
	}

	private toggleInspector(): void {
		const toolCallId = this.transcript.find((entry) => entry.id === this.selectedEntryId)?.tool?.toolCallId;
		if (toolCallId === undefined) {
			return;
		}
		if (this.expandedToolCallId === toolCallId) {
			this.expandedToolCallId = undefined;
			this.inspectorScrollOffset = 0;
			return;
		}
		this.expandedToolCallId = toolCallId;
		this.inspectorView = "summary";
		this.inspectorScrollOffset = 0;
	}

	private moveInspectorView(direction: -1 | 1): void {
		const inspector = this.activeInspector();
		const selectedToolCallId = this.transcript.find((entry) => entry.id === this.selectedEntryId)?.tool?.toolCallId;
		if (!inspector || inspector.tool.toolCallId !== selectedToolCallId) {
			return;
		}
		const views = availableInspectorViews(inspector.tool, this.toolRenderer);
		const current = views.indexOf(this.inspectorView);
		const next = Math.max(0, Math.min(views.length - 1, current + direction));
		this.inspectorView = views[next] ?? "summary";
		this.inspectorScrollOffset = 0;
	}

	private moveInspectorScroll(delta: number): void {
		if (!this.activeInspector()) {
			return;
		}
		this.inspectorScrollOffset = Math.max(0, Math.min(this.inspectorMaxScroll(), this.inspectorScrollOffset + delta));
	}

	private inspectorMaxScroll(): number {
		const inspector = this.activeInspector();
		return inspector ? Math.max(0, detailLines(inspector.tool, this.inspectorView, this.toolRenderer).length - 1) : 0;
	}

	private recordIncomingEvent(): void {
		if (!this.followingLatest) {
			this.unseenEventCount += 1;
		}
	}

	private finishPicker(index: number): void {
		const resolve = this.picker?.resolve;
		this.picker = undefined;
		resolve?.(index);
		this.repaint();
	}

	private finishPickerMatch(): void {
		const match = this.picker?.matches[this.picker.index];
		if (match === undefined) {
			this.repaint();
			return;
		}
		this.finishPicker(match);
	}

	private filterPicker(): void {
		if (!this.picker) {
			return;
		}
		const query = this.picker.query.trim().toLowerCase();
		this.picker.matches = this.picker.items
			.map((item, index) => ({ item, index }))
			.filter(({ item }) => matchesQuery(item, query))
			.map(({ index }) => index);
		this.picker.index = Math.min(this.picker.index, Math.max(0, this.picker.matches.length - 1));
	}

	private rememberPrompt(value: string): void {
		if (this.promptHistory[this.promptHistory.length - 1] !== value) {
			this.promptHistory.push(value);
			if (this.promptHistory.length > MAX_PROMPT_HISTORY) {
				this.promptHistory.shift();
			}
		}
		this.historyIndex = undefined;
		this.historyDraft = "";
	}

	private resetHistoryNavigation(): void {
		this.historyIndex = undefined;
		this.historyDraft = "";
	}

	private recallPreviousPrompt(): void {
		if (this.promptHistory.length === 0) {
			return;
		}
		if (this.historyIndex === undefined) {
			this.historyDraft = this.editor.value;
			this.historyIndex = this.promptHistory.length - 1;
		} else {
			this.historyIndex = Math.max(0, this.historyIndex - 1);
		}
		this.editor.set(this.promptHistory[this.historyIndex] ?? "");
	}

	private recallNextPrompt(): void {
		if (this.historyIndex === undefined) {
			return;
		}
		if (this.historyIndex >= this.promptHistory.length - 1) {
			this.editor.set(this.historyDraft);
			this.resetHistoryNavigation();
			return;
		}
		this.historyIndex += 1;
		this.editor.set(this.promptHistory[this.historyIndex] ?? "");
	}

	private entry(kind: TuiTranscriptEntry["kind"], text: string, tool?: TuiToolSnapshot): TuiTranscriptEntry {
		this.nextEntryId += 1;
		return { id: `entry-${this.nextEntryId}`, kind, text, tool, createdAt: Date.now() };
	}

	private findTool(toolCallId: string): TuiTranscriptEntry | undefined {
		for (let index = this.transcript.length - 1; index >= 0; index -= 1) {
			const entry = this.transcript[index];
			if (entry?.kind === "tool" && entry.tool?.toolCallId === toolCallId) {
				return entry;
			}
		}
		return undefined;
	}

	private columns(): number {
		return this.fixedColumns ?? (this.stdout.columns && this.stdout.columns > 0 ? this.stdout.columns : 80);
	}

	private rows(): number {
		return this.fixedRows ?? (this.stdout.rows && this.stdout.rows > 0 ? this.stdout.rows : 24);
	}

	private repaint(): void {
		if (this.probePending) {
			// Deferred until the width probe resolves — painting with the wrong
			// ambiguous-width assumption wraps rows and desyncs absolute writes.
			return;
		}
		const frame = renderFrameEx(this.frameState(), this.columns(), this.rows());
		this.lastHits = frame.hits;
		this.lastBodyHeight = frame.bodyHeight;
		this.screen.paint(frame.lines, frame.cursor);
	}

	private syncTicker(): void {
		const active =
			this.streaming ||
			this.transcript.some((entry) => typeof entry !== "string" && entry.tool?.state === "running");
		if (active && this.ticker === undefined) {
			this.ticker = setInterval(
				() => {
					this.tickCount += 1;
					this.repaint();
				},
				this.motion ? 120 : 1000,
			);
			this.ticker.unref?.();
		} else if (!active && this.ticker !== undefined) {
			clearInterval(this.ticker);
			this.ticker = undefined;
		}
	}

	private frameState(): TuiFrameState {
		const now = Date.now();
		return {
			status: this.statusFn(),
			header: this.headerFn?.(),
			transcript: this.transcript,
			editorLines: this.editor.displayLines(),
			editorCursor: this.editor.displayCursor(),
			editorPlaceholder:
				this.editor.value.length === 0
					? this.streaming
						? "queue a message for the running agent…"
						: "message — / for commands · ctrl+p palette"
					: undefined,
			editorSelection: this.editor.displaySelection(),
			confirm: this.confirm?.request,
			confirmFocused: this.confirm ? this.confirmFocused : undefined,
			hint: this.transientHint,
			picker: this.picker
				? {
						title: this.picker.title,
						items: this.picker.matches.map((index) => this.picker?.items[index] ?? ""),
						index: this.picker.index,
						query: this.picker.query,
					}
				: undefined,
			completion: this.completion,
			completionRows: this.completionRows,
			inspector: this.activeInspector(),
			focus: this.focus,
			selectedEntryId: this.selectedEntryId,
			followLatest: this.followingLatest,
			unseenEventCount: this.unseenEventCount,
			streaming: this.streaming,
			colors: this.colors,
			transcriptScrollOffset: this.transcriptScrollOffset,
			toolRenderer: this.toolRenderer,
			now,
			tick: this.tickCount,
			motion: this.motion,
			runElapsedMs: this.streaming && this.runStartedAt !== undefined ? now - this.runStartedAt : undefined,
			entryCache: this.entryCache,
			glyphTheme: this.glyphTheme,
		};
	}

	private activeInspector(): TuiInspectorState | undefined {
		if (this.expandedToolCallId === undefined) {
			return undefined;
		}
		for (let index = this.transcript.length - 1; index >= 0; index -= 1) {
			const entry = this.transcript[index];
			if (entry?.kind === "tool" && entry.tool?.toolCallId === this.expandedToolCallId) {
				return { tool: entry.tool, view: this.inspectorView, scrollOffset: this.inspectorScrollOffset };
			}
		}
		return undefined;
	}
}

function completionRowCount(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) {
		return DEFAULT_COMPLETION_ROWS;
	}
	return Math.max(1, Math.trunc(value));
}

function compactJson(value: unknown, maxChars: number): string {
	let text: string;
	try {
		text = JSON.stringify(value) ?? "";
	} catch {
		text = String(value);
	}
	return text.length <= maxChars ? text : `${text.slice(0, maxChars)}...`;
}

function matchesQuery(item: string, query: string): boolean {
	if (query.length === 0) {
		return true;
	}
	let cursor = 0;
	for (const char of query) {
		cursor = item.toLowerCase().indexOf(char, cursor);
		if (cursor < 0) {
			return false;
		}
		cursor += 1;
	}
	return true;
}

const DSR_REPORT = new RegExp(`${"\u001b"}\\[\\d+;(\\d+)R`);

function resolveGlyphTheme(option: "unicode" | "ascii" | "auto" | undefined): "unicode" | "ascii" | undefined {
	const env = process.env.Z_AGENT_GLYPHS;
	if (env === "unicode" || env === "ascii") {
		return env;
	}
	return option === "auto" ? undefined : option;
}

function formatBytes(size: number): string {
	if (size < 1024) {
		return `${size} B`;
	}
	if (size < 1024 * 1024) {
		return `${(size / 1024).toFixed(1)} KB`;
	}
	return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
