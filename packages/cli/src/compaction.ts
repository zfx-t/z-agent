/**
 * Token-threshold + overflow compaction. Summary uses the existing StreamFn.
 */

import type { AgentMessage } from "@z-agent/agent";
import type { AssistantMessage, Context, Message, Model, StreamFn } from "@z-agent/ai";
import { appendCompaction, type SessionRecord } from "./sessions.ts";

export interface CompactionOptions {
	contextWindow?: number;
	reserveTokens?: number;
	keepRecentTokens?: number;
	streamFn?: StreamFn;
	model?: Model;
}

const DEFAULT_WINDOW = 128_000;
const DEFAULT_RESERVE = 8_000;
const DEFAULT_KEEP = 4_000;

export function estimateTokens(messages: AgentMessage[]): number {
	let chars = 0;
	for (const message of messages) {
		chars += JSON.stringify(message).length;
	}
	return Math.ceil(chars / 4);
}

export function shouldCompact(messages: AgentMessage[], options: CompactionOptions = {}): boolean {
	const window =
		options.contextWindow !== undefined && Number.isFinite(options.contextWindow) && options.contextWindow > 0
			? options.contextWindow
			: DEFAULT_WINDOW;
	const reserve = options.reserveTokens ?? DEFAULT_RESERVE;
	return estimateTokens(messages) > window - reserve;
}

export function hasOverflowStop(messages: AgentMessage[]): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant") {
			return message.stopReason === "length";
		}
	}
	return false;
}

export function needsCompaction(messages: AgentMessage[], options: CompactionOptions = {}): boolean {
	return shouldCompact(messages, options) || hasOverflowStop(messages);
}

function fallbackSummary(dropped: AgentMessage[], kept: AgentMessage[]): string {
	return `Compacted ${dropped.length} earlier messages (~${estimateTokens(dropped)} tokens). Kept ${kept.length} recent messages (~${estimateTokens(kept)} tokens).`;
}

function droppedToUserText(dropped: AgentMessage[]): string {
	return dropped
		.map((message) => JSON.stringify(message))
		.join("\n")
		.slice(0, 80_000);
}

export async function summarizeDropped(dropped: AgentMessage[], streamFn: StreamFn, model: Model): Promise<string> {
	const context: Context = {
		systemPrompt:
			"Summarize the earlier coding-agent conversation for later turns. Keep file paths, decisions, and errors. No tools. Be concise.",
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: droppedToUserText(dropped) }],
				timestamp: Date.now(),
			} satisfies Message,
		],
	};
	const stream = await streamFn(model, context);
	const final: AssistantMessage = await stream.result();
	const text = final.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("")
		.trim();
	return text.length > 0 ? text : fallbackSummary(dropped, []);
}

export function splitKeptTail(
	messages: AgentMessage[],
	options: CompactionOptions = {},
): { kept: AgentMessage[]; dropped: AgentMessage[] } {
	const keepTokens = options.keepRecentTokens ?? DEFAULT_KEEP;
	let kept: AgentMessage[] = [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const next = [messages[i], ...kept];
		const tokens = estimateTokens(next);
		if (tokens > keepTokens && kept.length > 0) {
			break;
		}
		kept = next;
	}
	const dropped = messages.slice(0, messages.length - kept.length);
	return { kept, dropped };
}

export async function compactMessages(
	messages: AgentMessage[],
	options: CompactionOptions = {},
): Promise<{ kept: AgentMessage[]; summary: string }> {
	const { kept, dropped } = splitKeptTail(messages, options);
	let summary = fallbackSummary(dropped, kept);
	if (options.streamFn && options.model && dropped.length > 0) {
		summary = await summarizeDropped(dropped, options.streamFn, options.model);
	}
	return { kept, summary };
}

export async function applyCompactionToSession(
	session: SessionRecord,
	messages: AgentMessage[],
	options?: CompactionOptions,
): Promise<{
	kept: AgentMessage[];
	summary: string;
}> {
	const result = await compactMessages(messages, options);
	appendCompaction(session, result.summary);
	return result;
}
