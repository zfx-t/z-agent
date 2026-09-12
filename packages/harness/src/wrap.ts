import type { AgentTool, AgentToolResult } from "@z-agent/agent";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	emptyUsage,
	type Model,
	type StreamFn,
	type StreamOptions,
} from "@z-agent/ai";
import { streamOpId, toolOpId } from "./op-id.ts";
import { replayAssistantMessage } from "./replay.ts";
import { DEFAULT_RESUME_POLICY, OpInterruptedError, type ResumePolicy, withSandwich } from "./sandwich.ts";
import type { OpStore } from "./store.ts";

export interface WrapOptions {
	resume?: Partial<ResumePolicy>;
}

interface StreamIntent {
	model: string;
	api: string;
	messageCount: number;
	contextHash: string;
}

function throwInterrupted(opId: string, kind: "tool" | "stream"): never {
	throw new OpInterruptedError(opId, kind);
}

function errorAssistantMessage(model: Model, error: unknown, partial?: AssistantMessage): AssistantMessage {
	return {
		...(partial ?? {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "" }],
			usage: emptyUsage(),
		}),
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

function errorStream(model: Model, error: unknown): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const message = errorAssistantMessage(model, error);
	stream.push({ type: "start", partial: message });
	stream.push({ type: "error", reason: "error", error: message });
	stream.end(message);
	return stream;
}

/**
 * Wrap tools with the L5 sandwich. `tool:<toolCallId>` is the op id and the
 * intent hash pins `{ name, params }`; a settled/done op replays its stored
 * AgentToolResult, an `effect`-phase op follows the resume policy.
 */
export function wrapTools(tools: AgentTool[], store: OpStore, options?: WrapOptions): AgentTool[] {
	const policy = options?.resume?.interruptedTool ?? DEFAULT_RESUME_POLICY.interruptedTool;
	return tools.map((tool) => ({
		...tool,
		async execute(toolCallId, params, signal, onUpdate): Promise<AgentToolResult> {
			const opId = toolOpId(toolCallId);
			return await withSandwich<unknown, AgentToolResult>({
				store,
				opId,
				kind: "tool",
				intent: { name: tool.name, params },
				policy,
				onInterrupted: () => throwInterrupted(opId, "tool"),
				effect: () => tool.execute(toolCallId, params, signal, onUpdate),
			});
		},
	}));
}

/**
 * Wrap a StreamFn with the L5 sandwich. The op id is
 * `stream:<sessionId|anon>:<contextHash>`; the stored result is the final
 * AssistantMessage, replayed as a start → done/error → end stream on hit.
 * StreamOptions are never persisted.
 */
export function wrapStreamFn(streamFn: StreamFn, store: OpStore, options?: WrapOptions): StreamFn {
	const policy = options?.resume?.interruptedStream ?? DEFAULT_RESUME_POLICY.interruptedStream;
	return (model: Model, context: Context, streamOptions?: StreamOptions): AssistantMessageEventStream => {
		const { opId, contextHash } = streamOpId({
			sessionId: streamOptions?.sessionId,
			modelId: model.id,
			api: model.api,
			context,
		});
		const outer = createAssistantMessageEventStream();
		void (async () => {
			// `live`: the inner stream ran and its non-terminal events were teed.
			// `terminal`: the inner done/error event, held back until the result
			// is durably committed — consumers see completion only after settle.
			let live = false;
			let started = false;
			let lastPartial: AssistantMessage | undefined;
			let terminal: AssistantMessageEvent | undefined;
			try {
				const final = await withSandwich<StreamIntent, AssistantMessage>({
					store,
					opId,
					kind: "stream",
					intent: { model: model.id, api: model.api, messageCount: context.messages.length, contextHash },
					policy,
					onInterrupted: () => throwInterrupted(opId, "stream"),
					effect: async () => {
						live = true;
						const inner = await streamFn(model, context, streamOptions);
						for await (const event of inner) {
							if (event.type === "done" || event.type === "error") {
								terminal = event;
								continue;
							}
							if (event.type === "start") {
								started = true;
							}
							lastPartial = event.partial;
							outer.push(event);
						}
						return await inner.result();
					},
				});
				if (!live) {
					for await (const event of replayAssistantMessage(final)) {
						outer.push(event);
					}
				} else if (terminal) {
					outer.push(terminal);
				}
				outer.end(final);
			} catch (error) {
				if (started) {
					// A start already reached consumers; a second one would corrupt
					// the transcript — emit only the terminal error event.
					const message = errorAssistantMessage(model, error, lastPartial);
					outer.push({ type: "error", reason: "error", error: message });
				} else {
					for await (const event of errorStream(model, error)) {
						outer.push(event);
					}
				}
				outer.end();
			}
		})();
		return outer;
	};
}
