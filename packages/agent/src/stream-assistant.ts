/**
 * Provider effect boundary (ADR-0010): the only place the agent core consumes StreamFn.
 *
 * Keeps a partial assistant message in `context.messages` during the stream and
 * emits message_start / message_update / message_end. Applies transformContext
 * then convertToLlm before the provider call (ADR-0006).
 */

import type { AssistantMessage, Context, Message, StreamFn, StreamOptions } from "@z-agent/ai";
import type { AgentEventSink } from "./emit.ts";
import type { AgentContext, AgentLoopConfig, AgentMessage } from "./types.ts";

/**
 * Stream one assistant turn from the LLM into `context.messages`.
 *
 * - Sole provider I/O in the agent core (ADR-0010).
 * - Partial assistant lives in the transcript array while streaming.
 * - Failures are encoded on the final AssistantMessage (`error` / `aborted`);
 *   this function does not throw for provider failures.
 */
export async function streamAssistant(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn: StreamFn,
): Promise<AssistantMessage> {
	// AgentMessage[] → AgentMessage[] (optional prune / inject).
	// transformContext must treat input as read-only and return a new array when changing it.
	let messages: AgentMessage[] = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// AgentMessage[] → LLM Message[] (required dual-layer boundary)
	const llmMessages: Message[] = await config.convertToLlm(messages);

	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		// AgentTool → LLM Tool conversion lands with tool-execution PRs
	};

	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

	const streamOptions: StreamOptions = {
		apiKey: resolvedApiKey,
		temperature: config.temperature,
		maxTokens: config.maxTokens,
		sessionId: config.sessionId,
		samplingParams: config.samplingParams,
		signal,
	};

	const response = await streamFn(config.model, llmContext, streamOptions);

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	for await (const event of response) {
		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				await emit({ type: "message_start", message: { ...partialMessage } });
				break;

			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					await emit({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;

			case "done":
			case "error": {
				const finalMessage = await response.result();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					await emit({ type: "message_start", message: { ...finalMessage } });
				}
				await emit({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}

	// Stream ended without a terminal event — still settle from result().
	const finalMessage = await response.result();
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
	return finalMessage;
}
