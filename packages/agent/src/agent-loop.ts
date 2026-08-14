/**
 * Double-while agent loop (pi agent-loop oracle structure).
 *
 * Outer while: follow-up drain when the agent would otherwise stop.
 * Inner while: tool batches + steering injection after each turn.
 *
 * Drain points (oracle):
 * - Steering: after turn completes (tools finished), before next assistant
 * - Follow-up: only when no tools and no steering left
 *
 * Effect boundaries (ADR-0010):
 * - streamAssistant (provider)
 * - tool.execute (tool body only)
 *
 * Prepare (zod + beforeToolCall) and afterToolCall are non-effects.
 */

import type { AssistantMessage, StreamFn, ToolResultMessage } from "@z-agent/ai";
import { EventStream } from "@z-agent/ai";
import type { AgentEventSink } from "./emit.ts";
import { streamAssistant } from "./stream-assistant.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
} from "./types.ts";

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/**
 * Start a loop with new prompt messages; events are pushed onto a returned EventStream.
 * `runAgentLoop` remains the async implementation. Wrapper catches rejection so
 * {@link EventStream.result} does not hang (ADR-0015 fork vs pi's uncaught `.then`).
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();
	void runAgentLoop(
		prompts,
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then(
		(messages) => {
			stream.end(messages);
		},
		() => {
			stream.end();
		},
	);
	return stream;
}

/**
 * Continue a loop from the current context; events are pushed onto a returned EventStream.
 * Last message must not be an assistant (validated here, matching runAgentLoopContinue).
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	const last = context.messages[context.messages.length - 1];
	if (last && isAssistantRole(last)) {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();
	void runAgentLoopContinue(
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then(
		(messages) => {
			stream.end(messages);
		},
		() => {
			stream.end();
		},
	);
	return stream;
}

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
 * When the assistant requests tools: prepare → execute → after
 * (parallel three-phase by default; sequential when configured or forced).
 * hasMoreToolCalls stays true unless every finalized result sets terminate:true.
 *
 * Steering is polled after each completed turn (tools already finished).
 * Follow-up is polled only when the agent would stop (no tools, no steering).
 */
export async function runLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn: StreamFn,
): Promise<void> {
	let currentContext = initialContext;
	let config = initialConfig;
	let firstTurn = true;
	// Steering may already be queued when the run starts (user typed while waiting).
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) ?? [];

	// Outer loop: continues when follow-up messages arrive after the agent would stop.
	while (true) {
		let hasMoreToolCalls = true;

		// Inner loop: tool batches and steering injection.
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (!firstTurn) {
				await emit({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// Inject pending steering / follow-up before the next assistant response.
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

			const toolCalls = message.content.filter((c): c is AgentToolCall => c.type === "toolCall");
			const toolResults: ToolResultMessage[] = [];
			hasMoreToolCalls = false;

			if (toolCalls.length > 0) {
				// length stop: args may be truncated — fail entire batch without execute.
				const batch =
					message.stopReason === "length"
						? await failToolCallsFromTruncatedMessage(toolCalls, emit)
						: await executeToolCalls(currentContext, message, toolCalls, config, signal, emit);
				toolResults.push(...batch.messages);
				hasMoreToolCalls = !batch.terminate;

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}

			await emit({ type: "turn_end", message, toolResults });

			if (signal?.aborted) {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			const nextTurnContext = {
				message,
				toolResults,
				context: currentContext,
				newMessages,
			};
			const nextTurnSnapshot = await config.prepareNextTurn?.(nextTurnContext);
			if (nextTurnSnapshot) {
				currentContext = nextTurnSnapshot.context ?? currentContext;
				config = {
					...config,
					model: nextTurnSnapshot.model ?? config.model,
					reasoning:
						nextTurnSnapshot.thinkingLevel === undefined
							? config.reasoning
							: nextTurnSnapshot.thinkingLevel === "off"
								? undefined
								: nextTurnSnapshot.thinkingLevel,
				};
			}

			if (
				await config.shouldStopAfterTurn?.({
					message,
					toolResults,
					context: currentContext,
					newMessages,
				})
			) {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// Steering after turn completes (tools finished); does not skip pending tools.
			pendingMessages = (await config.getSteeringMessages?.()) ?? [];
		}

		// Agent would stop here. Check for follow-up messages.
		const followUpMessages = (await config.getFollowUpMessages?.()) ?? [];
		if (followUpMessages.length > 0) {
			pendingMessages = followUpMessages;
			continue;
		}

		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}

// ---------------------------------------------------------------------------
// Tool pipeline (prepare → execute → after; sequential or parallel three-phase)
// ---------------------------------------------------------------------------

type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	terminate: boolean;
};

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool;
	args: unknown;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult;
	isError: boolean;
};

type FinalizedToolCallOutcome = {
	toolCall: AgentToolCall;
	result: AgentToolResult;
	isError: boolean;
};

/** Immediate outcome or deferred execute+finalize thunk (parallel path). */
type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);

/**
 * Fail all tool calls when stopReason is "length" (token limit mid-stream).
 * Arguments may validate but be incomplete — never execute.
 */
async function failToolCallsFromTruncatedMessage(
	toolCalls: AgentToolCall[],
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const messages: ToolResultMessage[] = [];
	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});
		const finalized: FinalizedToolCallOutcome = {
			toolCall,
			result: createErrorToolResult(
				`Tool call "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
			),
			isError: true,
		};
		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}
	return { messages, terminate: false };
}

/**
 * Dispatch sequential vs parallel tool execution.
 * Sequential when config.toolExecution === "sequential" or any tool has executionMode sequential.
 * Default (undefined toolExecution) is parallel, matching pi.
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const hasSequentialToolCall = toolCalls.some(
		(tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
	);
	if (config.toolExecution === "sequential" || hasSequentialToolCall) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
}

/**
 * Sequential prepare → execute → after for each tool call in assistant order.
 */
async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		let finalized: FinalizedToolCallOutcome;
		if (preparation.kind === "immediate") {
			finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			};
		} else {
			const executed = await executePreparedToolCall(preparation, signal, emit);
			finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
		}

		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		finalizedCalls.push(finalized);
		messages.push(toolResultMessage);

		if (signal?.aborted) {
			const remaining = await emitAbortedToolResults(toolCalls.slice(finalizedCalls.length), emit);
			finalizedCalls.push(...remaining.finalized);
			messages.push(...remaining.messages);
			break;
		}
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(finalizedCalls),
	};
}

/**
 * Parallel three-phase (pi executeToolCallsParallel):
 * 1. Prepare all sequentially (tool_execution_start + prepare; immediate ends emit now)
 * 2. Execute allowed concurrently (Promise.all of deferred thunks)
 * 3. tool_execution_end in completion order (emitted inside each thunk as it settles);
 *    toolResult message artifacts in assistant source order after all settle
 */
async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallEntry[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			const finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			} satisfies FinalizedToolCallOutcome;
			await emitToolExecutionEnd(finalized, emit);
			finalizedCalls.push(finalized);
			if (signal?.aborted) {
				break;
			}
			continue;
		}

		finalizedCalls.push(async () => {
			const executed = await executePreparedToolCall(preparation, signal, emit);
			const finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
			await emitToolExecutionEnd(finalized, emit);
			return finalized;
		});
		if (signal?.aborted) {
			break;
		}
	}

	// Concurrent execute: ends fire in completion order as each thunk settles.
	// Promise.all result array preserves source order for toolResult emission.
	const orderedFinalizedCalls = await Promise.all(
		finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
	);
	if (orderedFinalizedCalls.length < toolCalls.length) {
		const remaining = await emitAbortedToolResults(toolCalls.slice(orderedFinalizedCalls.length), emit, {
			emitMessages: false,
		});
		orderedFinalizedCalls.push(...remaining.finalized);
	}
	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
	};
}

function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((f) => f.result.terminate === true);
}

async function emitAbortedToolResults(
	toolCalls: AgentToolCall[],
	emit: AgentEventSink,
	options: { emitMessages?: boolean } = {},
): Promise<{ finalized: FinalizedToolCallOutcome[]; messages: ToolResultMessage[] }> {
	const emitMessages = options.emitMessages !== false;
	const finalized: FinalizedToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];
	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});
		const outcome: FinalizedToolCallOutcome = {
			toolCall,
			result: createErrorToolResult("Operation aborted"),
			isError: true,
		};
		await emitToolExecutionEnd(outcome, emit);
		finalized.push(outcome);
		if (emitMessages) {
			const toolResultMessage = createToolResultMessage(outcome);
			await emitToolResultMessage(toolResultMessage, emit);
			messages.push(toolResultMessage);
		}
	}
	return { finalized, messages };
}

/**
 * prepareArguments (optional) → zod safeParse → beforeToolCall.
 * Unknown tool / invalid args / block → immediate error result (no execute).
 */
async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			isError: true,
		};
	}

	try {
		const argsForValidation = tool.prepareArguments ? tool.prepareArguments(toolCall.arguments) : toolCall.arguments;
		const parsed = tool.parameters.safeParse(argsForValidation);
		if (!parsed.success) {
			const issues = parsed.error.issues
				.map((issue) => {
					const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
					return `  - ${path}: ${issue.message}`;
				})
				.join("\n");
			return {
				kind: "immediate",
				result: createErrorToolResult(
					`Validation failed for tool "${toolCall.name}":\n${issues || parsed.error.message}\n\nReceived arguments:\n${JSON.stringify(toolCall.arguments, null, 2)}`,
				),
				isError: true,
			};
		}
		const validatedArgs = parsed.data;

		if (config.beforeToolCall) {
			const beforeResult = await config.beforeToolCall(
				{
					assistantMessage,
					toolCall,
					args: validatedArgs,
					context: currentContext,
				},
				signal,
			);
			if (signal?.aborted) {
				return {
					kind: "immediate",
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				};
			}
			if (beforeResult?.block) {
				const result = createErrorToolResult(beforeResult.reason || "Tool execution was blocked");
				if (beforeResult.terminate === true) {
					result.terminate = true;
				}
				return {
					kind: "immediate",
					result,
					isError: true,
				};
			}
		}

		if (signal?.aborted) {
			return {
				kind: "immediate",
				result: createErrorToolResult("Operation aborted"),
				isError: true,
			};
		}

		return {
			kind: "prepared",
			toolCall,
			tool,
			args: validatedArgs,
		};
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

/** Sole tool-body effect boundary (ADR-0010). */
async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
	const updateEvents: Promise<void>[] = [];
	let acceptingUpdates = true;

	try {
		const result = await prepared.tool.execute(prepared.toolCall.id, prepared.args, signal, (partialResult) => {
			if (!acceptingUpdates) return;
			updateEvents.push(
				Promise.resolve(
					emit({
						type: "tool_execution_update",
						toolCallId: prepared.toolCall.id,
						toolName: prepared.toolCall.name,
						args: prepared.toolCall.arguments,
						partialResult,
					}),
				),
			);
		});
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return { result, isError: false };
	} catch (error) {
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return {
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	} finally {
		acceptingUpdates = false;
	}
}

/** afterToolCall field-by-field merge (non-effect). */
async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
	let result = executed.result;
	let isError = executed.isError;

	if (config.afterToolCall) {
		try {
			const afterResult = await config.afterToolCall(
				{
					assistantMessage,
					toolCall: prepared.toolCall,
					args: prepared.args,
					result,
					isError,
					context: currentContext,
				},
				signal,
			);
			if (afterResult) {
				result = {
					...result,
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					usage: afterResult.usage ?? result.usage,
					terminate: afterResult.terminate ?? result.terminate,
				};
				isError = afterResult.isError ?? isError;
			}
		} catch (error) {
			result = createErrorToolResult(error instanceof Error ? error.message : String(error));
			isError = true;
		}
	}

	return {
		toolCall: prepared.toolCall,
		result,
		isError,
	};
}

function createErrorToolResult(message: string): AgentToolResult {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
}

function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		content: finalized.result.content ?? [],
		details: finalized.result.details,
		usage: finalized.result.usage,
		...(finalized.result.addedToolNames?.length ? { addedToolNames: finalized.result.addedToolNames } : {}),
		isError: finalized.isError,
		timestamp: Date.now(),
	};
}

async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}

function isAssistantRole(message: AgentMessage): boolean {
	return typeof message === "object" && message !== null && "role" in message && message.role === "assistant";
}
