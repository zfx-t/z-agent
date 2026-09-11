import { DEFAULT_COMPLETION_ROWS, rankSlashCompletions, slashCompletionToken } from "./completion.ts";
import type { ConfirmChoice, ConfirmRequest } from "./confirm.ts";
import { confirmChoiceFromKey } from "./confirm.ts";
import { EditorBuffer } from "./editor.ts";
import type { TuiAction } from "./keymap.ts";
import { type ParsedKeymap, parseKeymapConfig, resolveAction } from "./keymap.ts";
import { type Key, parseInputChunk } from "./keys.ts";
import type { TuiEntryCache, TuiFrameState } from "./layout.ts";
import { renderFrameEx, transcriptViewportFor } from "./layout.ts";
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
	/** Chrome glyph set; "auto" uses ascii under CJK/ambiguous-width terminals. Z_AGENT_GLYPHS overrides. */
	glyphs?: "unicode" | "ascii" | "auto";
}

export interface PickListOptions {
	/** Value returned on Esc / Ctrl+C. Default 0. */
	cancelValue?: number;
}

const MAX_PROMPT_HISTORY = 100;

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
	private selectedToolCallId: string | undefined;
	private expandedToolCallId: string | undefined;
	private inspectorView: TuiInspectorView = "summary";
	private inspectorScrollOffset = 0;
	private followingLatest = true;
	private unseenEventCount = 0;
	/** First visible transcript row while scrolled back; undefined = follow latest. */
	private transcriptScrollOffset: number | undefined;
	private confirm: { request: ConfirmRequest; resolve: (choice: ConfirmChoice) => void } | undefined;
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
	private readonly glyphTheme: "unicode" | "ascii" | undefined;
	private readonly entryCache: TuiEntryCache = new WeakMap();
	private probePending = false;
	private probeTimer: NodeJS.Timeout | undefined;

	constructor(options: InteractiveTuiOptions = {}) {
		this.stdin = options.stdin ?? process.stdin;
		this.stdout = options.stdout ?? process.stdout;
		this.screen = new LineScreen((chunk) => {
			this.stdout.write(chunk);
		});
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
			this.confirm = { request: { toolName, args }, resolve };
			this.repaint();
		});
	}

	pickFromList(title: string, items: string[], options: PickListOptions = {}): Promise<number> {
		return new Promise((resolve) => {
			this.cancelCompletion();
			this.picker = {
				title,
				items,
				matches: items.map((_, index) => index),
				index: 0,
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
		if (this.picker) {
			if (key.type === "up") {
				this.picker.index = Math.max(0, this.picker.index - 1);
			} else if (key.type === "down") {
				this.picker.index = Math.min(this.picker.matches.length - 1, this.picker.index + 1);
			} else if (key.type === "enter") {
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
			const choice = confirmChoiceFromKey(key);
			if (choice) {
				const resolve = this.confirm.resolve;
				this.confirm = undefined;
				resolve(choice);
				this.repaint();
			}
			return;
		}
		if (action === "completion.accept" || action === "completion.next" || action === "completion.prev") {
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
		if (this.focus === "editor" && (key.type === "pageUp" || key.type === "pageDown")) {
			this.focus = "transcript";
			this.selectedToolCallId = undefined;
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
		} else if (key.type === "enter") {
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
		if (key.type !== "tab" && key.type !== "shiftTab") {
			return false;
		}
		let index = this.completion.index;
		if (this.completionAccepted || key.type === "shiftTab") {
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
		this.selectedToolCallId = this.toolEntries().at(-1)?.tool?.toolCallId;
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
			this.moveToolSelection(1);
			this.repaint();
			return;
		}
		if (action === "inspector.prev") {
			this.moveToolSelection(-1);
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
		if (key.type === "escape" || key.type === "tab") {
			this.focus = "editor";
			this.repaint();
			return;
		}
		if (key.type === "up") {
			if (this.toolEntries().length > 0) {
				this.moveToolSelection(-1);
			} else {
				this.scrollTranscript(-1);
			}
		} else if (key.type === "down") {
			if (this.toolEntries().length > 0) {
				this.moveToolSelection(1);
			} else {
				this.scrollTranscript(1);
			}
		} else if (key.type === "enter") {
			this.toggleInspector();
		} else if (key.type === "left") {
			this.moveInspectorView(-1);
		} else if (key.type === "right") {
			this.moveInspectorView(1);
		} else if (key.type === "char" && key.value === "g") {
			this.scrollTranscriptToTop();
		} else if (key.type === "char" && key.value === "G") {
			this.followTranscriptLatest();
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

	private toolEntries(): TuiTranscriptEntry[] {
		return this.transcript.filter(
			(entry): entry is TuiTranscriptEntry => entry.kind === "tool" && entry.tool !== undefined,
		);
	}

	private moveToolSelection(direction: -1 | 1): void {
		const entries = this.toolEntries();
		if (entries.length === 0) {
			return;
		}
		const current = entries.findIndex((entry) => entry.tool?.toolCallId === this.selectedToolCallId);
		const next = current < 0 ? entries.length - 1 : Math.max(0, Math.min(entries.length - 1, current + direction));
		this.selectedToolCallId = entries[next]?.tool?.toolCallId;
		this.transcriptScrollOffset = undefined;
		const isLatest = next === entries.length - 1;
		this.followingLatest = isLatest;
		if (isLatest) {
			this.unseenEventCount = 0;
		}
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
			this.selectedToolCallId = undefined;
		}
	}

	private scrollTranscriptToTop(): void {
		this.transcriptScrollOffset = 0;
		this.followingLatest = false;
		this.selectedToolCallId = undefined;
	}

	private followTranscriptLatest(): void {
		this.transcriptScrollOffset = undefined;
		this.followingLatest = true;
		this.unseenEventCount = 0;
	}

	private scrollPage(): number {
		const { bodyHeight } = transcriptViewportFor(this.frameState(), this.columns(), this.rows());
		return Math.max(1, bodyHeight - 3);
	}

	private toggleInspector(): void {
		if (this.selectedToolCallId === undefined) {
			return;
		}
		if (this.expandedToolCallId === this.selectedToolCallId) {
			this.expandedToolCallId = undefined;
			this.inspectorScrollOffset = 0;
			return;
		}
		this.expandedToolCallId = this.selectedToolCallId;
		this.inspectorView = "summary";
		this.inspectorScrollOffset = 0;
	}

	private moveInspectorView(direction: -1 | 1): void {
		const inspector = this.activeInspector();
		if (!inspector || inspector.tool.toolCallId !== this.selectedToolCallId) {
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
			confirm: this.confirm?.request,
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
			selectedToolCallId: this.selectedToolCallId,
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
