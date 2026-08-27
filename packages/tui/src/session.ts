import type { ConfirmChoice, ConfirmRequest } from "./confirm.ts";
import { confirmChoiceFromKey, formatConfirmPrompt } from "./confirm.ts";
import { EditorBuffer } from "./editor.ts";
import { type Key, parseInputChunk } from "./keys.ts";
import { renderFrame } from "./layout.ts";
import type {
	TuiFocus,
	TuiHeaderState,
	TuiInspectorState,
	TuiInspectorView,
	TuiToolSnapshot,
	TuiToolUpdate,
	TuiTranscriptEntry,
} from "./model.ts";
import { LineScreen } from "./screen.ts";
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
	private historyIndex: number | undefined;
	private historyDraft = "";
	private closed = false;
	private started = false;
	private readonly onInterrupt?: () => void;
	private readonly onData: (chunk: Buffer) => void;
	private readonly onResize: () => void;
	private nextEntryId = 0;
	private readonly toolStartedAt = new Map<string, number>();
	private pendingInput = "";

	constructor(options: InteractiveTuiOptions = {}) {
		this.stdin = options.stdin ?? process.stdin;
		this.stdout = options.stdout ?? process.stdout;
		this.screen = new LineScreen((chunk) => {
			this.stdout.write(chunk);
		});
		this.statusFn = options.status ?? (() => "z-agent");
		this.headerFn = options.header;
		this.onSubmitDuringRun = options.onSubmitDuringRun;
		this.fixedColumns = options.columns;
		this.fixedRows = options.rows;
		this.colors = options.colors ?? (this.stdout.isTTY === true && process.env.NO_COLOR === undefined);
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
		this.repaint();
	}

	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
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
		this.streaming = value;
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

	appendUser(text: string): void {
		this.transcript.push(this.entry("user", text));
		this.repaint();
	}

	clearTranscript(): void {
		this.transcript.length = 0;
		this.toolStartedAt.clear();
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
		};
		this.toolStartedAt.set(toolCallId, Date.now());
		this.transcript.push(this.entry("tool", `${toolName} ${tool.argsText}`, tool));
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
		const startedAt = this.toolStartedAt.get(toolCallId) ?? Date.now();
		entry.tool.durationMs = Math.max(0, Date.now() - startedAt);
		this.toolStartedAt.delete(toolCallId);
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
		this.repaint();
	}

	pasteImage(label = "[Image - pasted]"): void {
		this.resetHistoryNavigation();
		this.editor.insertPastedImage(label);
		this.repaint();
	}

	confirmTool(toolName: string, args: unknown): Promise<ConfirmChoice> {
		return new Promise((resolve) => {
			this.confirm = { request: { toolName, args }, resolve };
			this.repaint();
		});
	}

	pickFromList(title: string, items: string[], options: PickListOptions = {}): Promise<number> {
		return new Promise((resolve) => {
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
		return new Promise((resolve) => {
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

	private handleInput(raw: string): void {
		const parsed = parseInputChunk(`${this.pendingInput}${raw}`);
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
		if (key.type === "ctrl" && key.value === "c") {
			if (this.streaming) {
				this.appendNotice("warning", "abort requested");
				this.onInterrupt?.();
				return;
			}
			this.promptResolve?.(null);
			this.promptResolve = undefined;
			return;
		}
		if (key.type === "ctrl" && key.value === "t") {
			this.toggleLastThinking();
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
		if (key.type === "tab") {
			this.toggleFocus();
			this.repaint();
			return;
		}
		if (this.focus === "transcript") {
			this.dispatchTranscriptKey(key);
			return;
		}
		if (key.type === "ctrl" && key.value === "p" && this.editor.value.length === 0) {
			const resolve = this.promptResolve;
			this.promptResolve = undefined;
			resolve?.("/commands");
			this.repaint();
			return;
		}
		if (key.type === "paste") {
			this.resetHistoryNavigation();
			this.editor.insertPastedText(key.value, `[Pasted text - ${formatBytes(key.value.length)}]`);
		} else if (key.type === "char") {
			this.resetHistoryNavigation();
			this.editor.insert(key.value);
		} else if (key.type === "backspace") {
			this.resetHistoryNavigation();
			this.editor.backspace();
		} else if (key.type === "delete") {
			this.resetHistoryNavigation();
			this.editor.delete();
		} else if (key.type === "left") {
			this.editor.moveLeft();
		} else if (key.type === "right") {
			this.editor.moveRight();
		} else if (key.type === "home" || (key.type === "ctrl" && key.value === "a")) {
			this.editor.moveHome();
		} else if (key.type === "end" || (key.type === "ctrl" && key.value === "e")) {
			this.editor.moveEnd();
		} else if (key.type === "newline") {
			this.resetHistoryNavigation();
			this.editor.insert("\n");
		} else if (key.type === "up") {
			if (this.editor.isMultiline) {
				this.editor.moveUp();
			} else {
				this.recallPreviousPrompt();
			}
		} else if (key.type === "down") {
			if (this.editor.isMultiline) {
				this.editor.moveDown();
			} else {
				this.recallNextPrompt();
			}
		} else if (key.type === "ctrl" && key.value === "u") {
			this.resetHistoryNavigation();
			this.editor.clear();
		} else if (key.type === "ctrl" && key.value === "w") {
			this.resetHistoryNavigation();
			this.editor.deleteWordBackward();
		} else if (key.type === "enter") {
			if (this.streaming && !this.onSubmitDuringRun) {
				this.repaint();
				return;
			}
			const value = this.editor.submit().trim();
			if (value.length === 0) {
				this.repaint();
				return;
			}
			this.rememberPrompt(value);
			this.appendUser(value);
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
		this.repaint();
	}

	private toggleFocus(): void {
		if (this.focus === "transcript") {
			this.focus = "editor";
			return;
		}
		const latest = this.toolEntries().at(-1)?.tool?.toolCallId;
		if (latest === undefined) {
			return;
		}
		this.focus = "transcript";
		this.selectedToolCallId = latest;
		this.followingLatest = true;
		this.unseenEventCount = 0;
	}

	private dispatchTranscriptKey(key: Key): void {
		if (key.type === "escape" || key.type === "tab") {
			this.focus = "editor";
			this.repaint();
			return;
		}
		if (key.type === "up") {
			this.moveToolSelection(-1);
		} else if (key.type === "down") {
			this.moveToolSelection(1);
		} else if (key.type === "enter") {
			this.toggleInspector();
		} else if (key.type === "left") {
			this.moveInspectorView(-1);
		} else if (key.type === "right") {
			this.moveInspectorView(1);
		} else if (key.type === "pageUp") {
			this.moveInspectorScroll(-6);
		} else if (key.type === "pageDown") {
			this.moveInspectorScroll(6);
		} else if (key.type === "home") {
			if (this.activeInspector()) {
				this.inspectorScrollOffset = 0;
			} else {
				this.selectBoundaryTool("start");
			}
		} else if (key.type === "end") {
			if (this.activeInspector()) {
				this.inspectorScrollOffset = this.inspectorMaxScroll();
			} else {
				this.selectBoundaryTool("end");
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
		const isLatest = next === entries.length - 1;
		this.followingLatest = isLatest;
		if (isLatest) {
			this.unseenEventCount = 0;
		}
	}

	private selectBoundaryTool(boundary: "start" | "end"): void {
		const entries = this.toolEntries();
		if (entries.length === 0) {
			return;
		}
		const index = boundary === "start" ? 0 : entries.length - 1;
		this.selectedToolCallId = entries[index]?.tool?.toolCallId;
		this.followingLatest = boundary === "end";
		if (this.followingLatest) {
			this.unseenEventCount = 0;
		}
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
		const views = availableInspectorViews(inspector.tool);
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
		return inspector ? Math.max(0, detailLines(inspector.tool, this.inspectorView).length - 1) : 0;
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
		const lines = renderFrame(
			{
				status: this.statusFn(),
				header: this.headerFn?.(),
				transcript: this.transcript,
				editorLines: this.editor.displayLines(),
				confirm: this.confirm ? formatConfirmPrompt(this.confirm.request) : undefined,
				picker: this.picker
					? {
							title: this.picker.title,
							items: this.picker.matches.map((index) => this.picker?.items[index] ?? ""),
							index: this.picker.index,
							query: this.picker.query,
						}
					: undefined,
				inspector: this.activeInspector(),
				focus: this.focus,
				selectedToolCallId: this.selectedToolCallId,
				followLatest: this.followingLatest,
				unseenEventCount: this.unseenEventCount,
				streaming: this.streaming,
				colors: this.colors,
			},
			this.columns(),
			this.rows(),
		);
		this.screen.paint(lines);
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

function formatBytes(size: number): string {
	if (size < 1024) {
		return `${size} B`;
	}
	if (size < 1024 * 1024) {
		return `${(size / 1024).toFixed(1)} KB`;
	}
	return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
