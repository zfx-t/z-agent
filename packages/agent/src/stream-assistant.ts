/**
 * Provider effect boundary (ADR-0010): the only place the agent core consumes StreamFn.
 *
 * Keeps a partial assistant message in `context.messages` during the stream and
 * emits message_start / message_update / message_end. Applies prepareContext,
 * transformContext, then convertToLlm before the provider call (ADR-0006).
 */

import type { AssistantMessage, Context, Message, StreamFn, StreamOptions } from "@z-agent/ai";
import { emptyUsage } from "@z-agent/ai";
import type { AgentEventSink } from "./emit.ts";
import { agentToolsToLlmTools } from "./tool-json-schema.ts";
import type { AgentContext, AgentLoopConfig, AgentMessage } from "./types.ts";

function failureAssistantMessage(config: AgentLoopConfig, error: unknown, aborted: boolean): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: config.model.api,
		provider: config.model.provider,
		model: config.model.id,
		usage: emptyUsage(),
		stopReason: aborted ? "aborted" : "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

function snapshotAgentMessage(message: AgentMessage): AgentMessage {
	if (typeof message !== "object" || message === null) {
		return message;
	}
	const copy = { ...message } as unknown as { content?: unknown };
	if (Array.isArray(copy.content)) {
		copy.content = copy.content.map((block) => (typeof block === "object" && block !== null ? { ...block } : block));
	}
	return copy as AgentMessage;
}

/**
 * Stream one assistant turn from the LLM into `context.messages`.
 *
 * - Sole provider I/O in the agent core (ADR-0010).
 * - Partial assistant lives in the transcript array while streaming.
 * - Failures are encoded on the final AssistantMessage (`error` / `aborted`);
 *   this function does not throw for provider failures, including a throwing StreamFn.
 */
export async function streamAssistant(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn: StreamFn,
): Promise<AssistantMessage> {
	let preparedContext = context;
	if (config.prepareContext) {
		preparedContext = await config.prepareContext({
			...context,
			messages: context.messages.map(snapshotAgentMessage),
			tools: context.tools?.slice(),
		});
	}

	// AgentMessage[] → AgentMessage[] (optional prune / inject).
	// transformContext must treat input as read-only and return a new array when changing it.
	let messages: AgentMessage[] = preparedContext.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// AgentMessage[] → LLM Message[] (required dual-layer boundary)
	const llmMessages: Message[] = await config.convertToLlm(messages);

	const llmTools = agentToolsToLlmTools(preparedContext.tools ?? []);
	const llmContext: Context = {
		systemPrompt: preparedContext.systemPrompt,
		messages: llmMessages,
		...(llmTools.length > 0 ? { tools: llmTools } : {}),
	};

	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) ?? config.apiKey;

	const streamOptions: StreamOptions = {
		apiKey: resolvedApiKey,
		temperature: config.temperature,
		maxTokens: config.maxTokens,
		sessionId: config.sessionId,
		samplingParams: config.samplingParams,
		reasoning: config.reasoning,
		signal,
	};

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	try {
		const response = await streamFn(config.model, llmContext, streamOptions);

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
	} catch (error) {
		const finalMessage = failureAssistantMessage(config, error, signal?.aborted === true);
		if (addedPartial) {
			context.messages[context.messages.length - 1] = finalMessage;
		} else {
			context.messages.push(finalMessage);
			await emit({ type: "message_start", message: { ...finalMessage } });
		}
		await emit({ type: "message_end", message: finalMessage });
		return finalMessage;
	}
}
