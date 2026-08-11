/**
 * Double-while agent loop (pi agent-loop oracle structure).
 *
 * Outer while: follow-up drain (stub empty until queues land).
 * Inner while: tool batches + steering (PR3: tools deferred — no execute).
 *
 * Effect boundaries (ADR-0010): only streamAssistant (provider) performs I/O here.
 * tool.execute lands in PR4.
 */

import type { StreamFn, ToolResultMessage } from "@z-agent/ai";
import type { AgentEventSink } from "./emit.ts";
import { streamAssistant } from "./stream-assistant.ts";
import type { AgentContext, AgentLoopConfig, AgentMessage } from "./types.ts";

/**
 * Start a loop with new prompt messages.
 * Prompts are appended to an internal context copy and emitted as complete message pairs.
 *
 * Does not mutate `context.messages`. Callers own the transcript: append the returned
 * `newMessages` (prompts + assistant turns produced by this run) into their state.
 */
export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

/**
 * Continue a loop from the current context without adding a prompt.
 * Last message must convert to user or toolResult via convertToLlm (not validated here).
 *
 * Does not mutate `context.messages` (array is copied before streaming). Append the
 * returned `newMessages` (assistant turns from this continue only) into owned state.
 * Differs from pi, which shares the caller's messages array with streamAssistant.
 */
export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	const last = context.messages[context.messages.length - 1];
	if (last && isAssistantRole(last)) {
		throw new Error("Cannot continue from message role: assistant");
	}

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

/**
 * Shared double-while control flow.
 *
 * PR3: if the assistant requests tool calls, do not execute them — end the turn
 * with hasMoreToolCalls=false. PR4 wires prepare → execute → after.
 */
export async function runLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn: StreamFn,
): Promise<void> {
	const currentContext = initialContext;
	let firstTurn = true;
	// Steering drain (PR7); empty until queues land.
	let pendingMessages: AgentMessage[] = [];

	// Outer loop: follow-up drain when agent would stop (PR7; stub empty).
	while (true) {
		// Inner: tool batches and steering. PR3 never continues for tools.
		let hasMoreToolCalls = true;

		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (!firstTurn) {
				await emit({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			const message = await streamAssistant(currentContext, config, signal, emit, streamFn);
			newMessages.push(message);

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// PR3: tool execution deferred. Even when the assistant requested tools
			// (stopReason toolUse / toolCall content), do not execute — end the turn.
			// PR4 executes the batch and sets hasMoreToolCalls from the result.
			const toolResults: ToolResultMessage[] = [];
			hasMoreToolCalls = false;

			await emit({ type: "turn_end", message, toolResults });

			// Steering poll (PR7) — always empty for now.
			pendingMessages = [];
		}

		// Follow-up poll (PR7) — stub empty; exit outer loop.
		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}

function isAssistantRole(message: AgentMessage): boolean {
	return typeof message === "object" && message !== null && "role" in message && message.role === "assistant";
}
