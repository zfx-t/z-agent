import type { AgentEvent, AgentToolResult } from "@z-agent/agent";

const TOOL_RESULT_DISPLAY_CHARS = 800;
const ARGS_DISPLAY_CHARS = 240;

export interface StreamRendererOptions {
	verbose?: boolean;
	stdout?: { write: (chunk: string) => void };
}

function textFromToolResult(result: AgentToolResult): string {
	return result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
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
	private readonly stdout: { write: (chunk: string) => void };
	private atLineStart = true;

	constructor(options: StreamRendererOptions = {}) {
		this.verbose = options.verbose === true;
		this.stdout = options.stdout ?? process.stdout;
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
				this.line(`[tool] ${event.toolName} ${compactJson(event.args, ARGS_DISPLAY_CHARS)}`);
				break;
			case "tool_execution_end": {
				this.ensureNewline();
				if (event.isError) {
					const errText = clip(textFromToolResult(event.result), TOOL_RESULT_DISPLAY_CHARS);
					this.line(`[tool_end] ${event.toolName} error=${errText}`);
				} else {
					const body = clip(textFromToolResult(event.result).trimEnd(), TOOL_RESULT_DISPLAY_CHARS);
					if (body.length > 0) {
						this.line(body);
					}
					this.line(`[tool_end] ${event.toolName} error=false`);
				}
				break;
			}
			default:
				break;
		}
	}

	private write(text: string): void {
		if (text.length === 0) {
			return;
		}
		this.stdout.write(text);
		this.atLineStart = text.endsWith("\n");
	}

	private line(text: string): void {
		this.ensureNewline();
		this.stdout.write(`${text}\n`);
		this.atLineStart = true;
	}

	private ensureNewline(): void {
		if (!this.atLineStart) {
			this.stdout.write("\n");
			this.atLineStart = true;
		}
	}
}
