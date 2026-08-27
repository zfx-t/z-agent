import type { AgentEvent, AgentToolResult } from "@z-agent/agent";

const TOOL_RESULT_DISPLAY_CHARS = 800;
const ARGS_DISPLAY_CHARS = 240;
const ESC = "\u001b";
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");

export interface StreamRendererOptions {
	verbose?: boolean;
	stdout?: { isTTY?: boolean; write: (chunk: string) => void };
}

function textFromToolResult(result: AgentToolResult): string {
	return result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => cleanForTerminal(block.text))
		.join("");
}

function cleanForTerminal(text: string): string {
	return Array.from(text.replace(ANSI_PATTERN, ""))
		.filter((char) => {
			const code = char.codePointAt(0) ?? 0;
			return code === 0x0a || code === 0x09 || (code >= 0x20 && code !== 0x7f);
		})
		.join("");
}

function compactJson(value: unknown, maxChars: number): string {
	let text: string;
	try {
		text = JSON.stringify(value) ?? "";
	} catch {
		text = String(value);
	}
	if (text.length <= maxChars) {
		return text;
	}
	return `${text.slice(0, maxChars)}…`;
}

function clip(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}
	return `${text.slice(0, maxChars)}…`;
}

/**
 * Maps AgentEvents to stdout. Live text_delta only; no second print of the
 * full assistant message on message_end.
 */
export class StreamRenderer {
	private readonly verbose: boolean;
	private readonly stdout: { isTTY?: boolean; write: (chunk: string) => void };
	private readonly colors: boolean;
	private atLineStart = true;

	constructor(options: StreamRendererOptions = {}) {
		this.verbose = options.verbose === true;
		this.stdout = options.stdout ?? process.stdout;
		this.colors = this.stdout.isTTY === true && process.env.NO_COLOR === undefined;
	}

	handle(event: AgentEvent): void {
		switch (event.type) {
			case "agent_start":
			case "turn_start":
			case "turn_end":
			case "agent_end":
				if (this.verbose) {
					this.line(`[${event.type}]`);
				}
				if (event.type === "turn_end" || event.type === "agent_end") {
					this.ensureNewline();
				}
				break;
			case "message_start":
				if (this.verbose) {
					const role = "role" in event.message ? String(event.message.role) : "?";
					this.line(`[message_start] role=${role}`);
				}
				break;
			case "message_update":
				if (event.assistantMessageEvent.type === "text_delta") {
					this.write(event.assistantMessageEvent.delta);
				} else if (this.verbose) {
					this.line(`[${event.assistantMessageEvent.type}]`);
				}
				break;
			case "message_end":
				this.ensureNewline();
				if (this.verbose) {
					this.line("[message_end]");
				}
				break;
			case "tool_execution_start":
				this.ensureNewline();
				this.line(this.tone("info", `[tool] ${event.toolName} ${compactJson(event.args, ARGS_DISPLAY_CHARS)}`));
				break;
			case "tool_execution_end": {
				this.ensureNewline();
				if (event.isError) {
					const errText = clip(textFromToolResult(event.result), TOOL_RESULT_DISPLAY_CHARS);
					if (errText.length > 0) {
						this.toolOutput(errText);
					}
					this.line(this.tone("error", `[tool_end] ${event.toolName} error=true`));
				} else {
					const body = clip(textFromToolResult(event.result).trimEnd(), TOOL_RESULT_DISPLAY_CHARS);
					if (body.length > 0) {
						this.toolOutput(body);
					}
					this.line(this.tone("success", `[tool_end] ${event.toolName} error=false`));
				}
				break;
			}
			default:
				break;
		}
	}

	private write(text: string): void {
		const output = cleanForTerminal(text);
		if (output.length === 0) {
			return;
		}
		this.stdout.write(output);
		this.atLineStart = output.endsWith("\n");
	}

	private line(text: string): void {
		this.ensureNewline();
		this.stdout.write(`${text}\n`);
		this.atLineStart = true;
	}

	private toolOutput(text: string): void {
		if (!this.colors) {
			this.line(text);
			return;
		}
		for (const line of text.split("\n")) {
			this.line(this.tone("muted", `| ${line}`));
		}
	}

	private tone(tone: "error" | "info" | "muted" | "success", text: string): string {
		if (!this.colors) {
			return text;
		}
		const code =
			tone === "error"
				? "\x1b[38;5;203m"
				: tone === "success"
					? "\x1b[38;5;78m"
					: tone === "info"
						? "\x1b[38;5;45m"
						: "\x1b[2m";
		return `${code}${text}\x1b[0m`;
	}

	private ensureNewline(): void {
		if (!this.atLineStart) {
			this.stdout.write("\n");
			this.atLineStart = true;
		}
	}
}
