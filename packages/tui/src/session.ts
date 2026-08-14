import type { ConfirmChoice, ConfirmRequest } from "./confirm.ts";
import { confirmChoiceFromKey, formatConfirmPrompt } from "./confirm.ts";
import { EditorBuffer } from "./editor.ts";
import { type Key, parseKey } from "./keys.ts";
import { renderFrame } from "./layout.ts";
import { LineScreen } from "./screen.ts";

export interface InteractiveTuiOptions {
	stdin?: NodeJS.ReadStream;
	stdout?: NodeJS.WriteStream;
	columns?: number;
	rows?: number;
	status?: () => string;
	/** Ctrl+C while streaming (raw mode swallows SIGINT). */
	onInterrupt?: () => void;
}

export interface PickListOptions {
	/** Value returned on Esc / Ctrl+C. Default 0. */
	cancelValue?: number;
}

/**
 * Full-screen coding TUI: transcript, streaming deltas, editor, confirm modal.
 */
export class InteractiveTui {
	private readonly stdin: NodeJS.ReadStream;
	private readonly stdout: NodeJS.WriteStream;
	private readonly screen: LineScreen;
	private readonly editor = new EditorBuffer();
	private readonly transcript: string[] = [];
	private readonly statusFn: () => string;
	private streaming = false;
	private confirm: { request: ConfirmRequest; resolve: (choice: ConfirmChoice) => void } | undefined;
	private picker:
		| {
				title: string;
				items: string[];
				index: number;
				cancelValue: number;
				resolve: (index: number) => void;
		  }
		| undefined;
	private promptResolve: ((line: string | null) => void) | undefined;
	private closed = false;
	private started = false;
	private readonly onInterrupt?: () => void;
	private readonly onData: (chunk: Buffer) => void;

	constructor(options: InteractiveTuiOptions = {}) {
		this.stdin = options.stdin ?? process.stdin;
		this.stdout = options.stdout ?? process.stdout;
		this.screen = new LineScreen((chunk) => {
			this.stdout.write(chunk);
		});
		this.statusFn = options.status ?? (() => "z-agent");
		this.onInterrupt = options.onInterrupt;
		this.onData = (chunk) => {
			this.handleInput(chunk.toString("utf-8"));
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
		this.repaint();
	}

	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.stdin.off("data", this.onData);
		if (this.stdin.isTTY && typeof this.stdin.setRawMode === "function") {
			this.stdin.setRawMode(false);
		}
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
		if (this.transcript.length === 0 || !this.transcript[this.transcript.length - 1]?.startsWith("assistant:")) {
			this.transcript.push(`assistant:${delta}`);
		} else {
			this.transcript[this.transcript.length - 1] += delta;
		}
		this.wrapLast();
		this.repaint();
	}

	appendLine(line: string): void {
		this.transcript.push(line);
		this.repaint();
	}

	toggleLastThinking(): void {
		let last: string | undefined;
		for (let i = this.transcript.length - 1; i >= 0; i--) {
			if (this.transcript[i].startsWith("thinking:")) {
				last = this.transcript[i];
				break;
			}
		}
		if (!last) {
			return;
		}
		const index = this.transcript.lastIndexOf(last);
		if (last.startsWith("thinking:[hidden]")) {
			this.transcript[index] = last.replace("thinking:[hidden]", "thinking:");
		} else {
			this.transcript[index] = `thinking:[hidden] ${last.slice("thinking:".length).length} chars`;
		}
		this.repaint();
	}

	appendThinkingDelta(delta: string): void {
		if (this.transcript.length === 0 || !this.transcript[this.transcript.length - 1]?.startsWith("thinking:")) {
			this.transcript.push(`thinking:${delta}`);
		} else if (!this.transcript[this.transcript.length - 1].startsWith("thinking:[hidden]")) {
			this.transcript[this.transcript.length - 1] += delta;
		}
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
				index: 0,
				cancelValue: options.cancelValue ?? 0,
				resolve,
			};
			this.repaint();
		});
	}

	readPrompt(): Promise<string | null> {
		return new Promise((resolve) => {
			this.promptResolve = resolve;
			this.repaint();
		});
	}

	/** Test helper: feed a parsed key. */
	pushKey(key: Key): void {
		this.dispatch(key);
	}

	private handleInput(raw: string): void {
		const key = parseKey(raw);
		if (!key) {
			return;
		}
		this.dispatch(key);
	}

	private dispatch(key: Key): void {
		if (this.closed) {
			return;
		}
		if (this.picker) {
			if (key.type === "up") {
				this.picker.index = Math.max(0, this.picker.index - 1);
			} else if (key.type === "down") {
				this.picker.index = Math.min(this.picker.items.length - 1, this.picker.index + 1);
			} else if (key.type === "enter") {
				this.finishPicker(this.picker.index);
				return;
			} else if (key.type === "escape" || (key.type === "ctrl" && key.value === "c")) {
				this.finishPicker(this.picker.cancelValue);
				return;
			} else if (key.type === "char" && key.value.length === 1 && key.value >= "1" && key.value <= "9") {
				const index = Number(key.value) - 1;
				if (index < this.picker.items.length) {
					this.finishPicker(index);
					return;
				}
			}
			this.repaint();
			return;
		}
		if (key.type === "ctrl" && key.value === "c") {
			if (this.streaming) {
				this.appendLine("[abort requested]");
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
		if (this.streaming) {
			return;
		}
		if (key.type === "char") {
			this.editor.insert(key.value);
		} else if (key.type === "backspace") {
			this.editor.backspace();
		} else if (key.type === "enter") {
			const value = this.editor.submit().trim();
			if (value.length === 0) {
				this.repaint();
				return;
			}
			this.transcript.push(`you: ${value}`);
			const resolve = this.promptResolve;
			this.promptResolve = undefined;
			resolve?.(value);
		}
		this.repaint();
	}

	private finishPicker(index: number): void {
		const resolve = this.picker?.resolve;
		this.picker = undefined;
		resolve?.(index);
		this.repaint();
	}

	private wrapLast(): void {
		const last = this.transcript[this.transcript.length - 1];
		if (!last) {
			return;
		}
		const width = this.columns();
		if (last.length <= width) {
			return;
		}
		const chunks: string[] = [];
		for (let i = 0; i < last.length; i += width) {
			chunks.push(last.slice(i, i + width));
		}
		this.transcript.splice(this.transcript.length - 1, 1, ...chunks);
	}

	private columns(): number {
		return this.stdout.columns && this.stdout.columns > 0 ? this.stdout.columns : 80;
	}

	private rows(): number {
		return this.stdout.rows && this.stdout.rows > 0 ? this.stdout.rows : 24;
	}

	private repaint(): void {
		const lines = renderFrame(
			{
				status: this.statusFn(),
				transcript: this.transcript,
				editorLines: this.editor.displayLines(),
				confirm: this.confirm ? formatConfirmPrompt(this.confirm.request) : undefined,
				picker: this.picker
					? { title: this.picker.title, items: this.picker.items, index: this.picker.index }
					: undefined,
				streaming: this.streaming,
			},
			this.columns(),
			this.rows(),
		);
		this.screen.paint(lines);
	}
}
