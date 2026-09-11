/** AgentMessage → TUI transcript helpers (preview caps and session replay). */
import type { AgentMessage, AgentToolResult } from "@z-agent/agent";
import type { ToolResultMessage, UserMessage } from "@z-agent/ai";
import type { InteractiveTui } from "@z-agent/tui";

const TOOL_RESULT_PREVIEW_CHARS = 720;
const TOOL_DETAILS_PREVIEW_CHARS = 520;

export function toolResultPreview(result: AgentToolResult): string {
	const text = result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("")
		.trim();
	return text.length <= TOOL_RESULT_PREVIEW_CHARS ? text : `${text.slice(0, TOOL_RESULT_PREVIEW_CHARS)}...`;
}

export function compactDetails(details: unknown): string | undefined {
	if (details === undefined || details === null) {
		return undefined;
	}
	let text: string;
	try {
		text = JSON.stringify(details) ?? "";
	} catch {
		text = String(details);
	}
	return text.length <= TOOL_DETAILS_PREVIEW_CHARS ? text : `${text.slice(0, TOOL_DETAILS_PREVIEW_CHARS)}...`;
}

function userReplayText(content: UserMessage["content"]): string {
	if (typeof content === "string") {
		return content;
	}
	return content
		.map((block) => (block.type === "text" ? block.text : "[image]"))
		.join("\n")
		.trim();
}

function resultReplayText(message: ToolResultMessage): string {
	return toolResultPreview({ content: message.content, details: message.details });
}

/**
 * Repaint a restored session's leaf messages: user turns, assistant text and
 * thinking, and tool rows paired by toolCallId. Calls without a recorded
 * toolResult are closed as errors instead of left spinning.
 */
export function replayTranscript(tui: InteractiveTui, messages: readonly AgentMessage[]): void {
	const knownCalls = new Set<string>();
	const pendingCalls = new Set<string>();
	for (const message of messages) {
		if (message.role === "user") {
			const text = userReplayText(message.content);
			if (text.length > 0) {
				tui.appendUser(text, false);
			}
			continue;
		}
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "text") {
					tui.appendAssistantDelta(block.text);
				} else if (block.type === "thinking") {
					tui.appendThinkingDelta(block.thinking);
				} else if (block.type === "toolCall") {
					knownCalls.add(block.id);
					pendingCalls.add(block.id);
					tui.appendToolStart(block.id, block.name, block.arguments);
				}
			}
			if (message.errorMessage) {
				tui.appendNotice("error", message.errorMessage);
			}
			continue;
		}
		if (message.role === "toolResult") {
			if (!knownCalls.has(message.toolCallId)) {
				tui.appendToolStart(message.toolCallId, message.toolName, {});
			}
			pendingCalls.delete(message.toolCallId);
			tui.appendToolEnd(
				message.toolCallId,
				resultReplayText(message),
				message.isError,
				compactDetails(message.details),
			);
		}
	}
	for (const toolCallId of pendingCalls) {
		tui.appendToolEnd(toolCallId, "(no result recorded)", true);
	}
}
