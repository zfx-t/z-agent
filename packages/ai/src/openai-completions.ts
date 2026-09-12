/**
 * OpenAI Chat Completions stream adapter (ADR-0027).
 *
 * Legacy / compat path: POST {base}/chat/completions with stream:true and
 * stream_options.include_usage. Used for providers that speak the older
 * completions dialect (DeepSeek, Together, Groq, OpenRouter, …) via baseUrl.
 *
 * Contract identical to openai-responses: failures are encoded on the final
 * AssistantMessage; the StreamFn never throws once invoked.
 */

import type { AssistantMessageEventStream } from "./event-stream.ts";
import { createAssistantMessageEventStream } from "./event-stream.ts";
import {
	applyParsedToolArguments,
	createPendingOutput,
	env,
	formatError,
	isAbortError,
	normalizeToolCallIdParts,
	type ProviderHttpConfig,
	resolveHttpConfig,
	type StreamingToolCall,
	toolResultText,
	trimTrailingSlash,
} from "./provider-shared.ts";
import { fetchWithRetry } from "./retry.ts";
import { parseSseJson } from "./sse.ts";
import { linkAbort, type StreamTimeoutError, withIdleTimeout } from "./timeouts.ts";
import type {
	AssistantMessage,
	Context,
	Model,
	StopReason,
	StreamFn,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	Usage,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Constants + config
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_API = "openai-completions";
const DEFAULT_PROVIDER = "openai";

export interface OpenAICompletionsConfig extends ProviderHttpConfig {
	/** Default API key when StreamOptions.apiKey is omitted. Falls back to OPENAI_API_KEY. */
	apiKey?: string;
	/** Default base URL when Model.baseUrl is empty. Falls back to OPENAI_BASE_URL. */
	baseUrl?: string;
}

export interface OpenAICompletionsStreamOptions extends StreamOptions {
	/** Override base URL for this call (else model.baseUrl / config / env). */
	baseUrl?: string;
}

// ---------------------------------------------------------------------------
// Wire types (minimal Chat Completions subset)
// ---------------------------------------------------------------------------

type CompletionsMessage =
	| { role: "system" | "developer"; content: string }
	| { role: "user"; content: string | CompletionsUserContent[] }
	| { role: "assistant"; content: string | null; tool_calls?: CompletionsToolCall[] }
	| { role: "tool"; tool_call_id: string; content: string };

interface CompletionsUserText {
	type: "text";
	text: string;
}

interface CompletionsUserImage {
	type: "image_url";
	image_url: { url: string };
}

type CompletionsUserContent = CompletionsUserText | CompletionsUserImage;

interface CompletionsToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

interface CompletionsTool {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

interface CompletionsCreateBody {
	model: string;
	messages: CompletionsMessage[];
	stream: true;
	stream_options?: { include_usage: true };
	tools?: CompletionsTool[];
	temperature?: number;
	max_tokens?: number;
	reasoning_effort?: string;
	[key: string]: unknown;
}

interface CompletionsChunk {
	id?: string;
	choices?: Array<{
		index?: number;
		delta?: {
			role?: string;
			content?: string | null;
			/** DeepSeek-style reasoning stream field. */
			reasoning_content?: string | null;
			tool_calls?: Array<{
				index?: number;
				id?: string;
				type?: string;
				function?: { name?: string; arguments?: string };
			}>;
		};
		finish_reason?: string | null;
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
		prompt_tokens_details?: { cached_tokens?: number };
		completion_tokens_details?: { reasoning_tokens?: number };
	};
	/** Some gateways stream an error object instead of failing HTTP. */
	error?: { message?: string; type?: string; code?: string };
}

// ---------------------------------------------------------------------------
// URL / key helpers
// ---------------------------------------------------------------------------

function resolveBaseUrl(
	model: Model,
	options?: OpenAICompletionsStreamOptions,
	config?: OpenAICompletionsConfig,
): string {
	const raw =
		options?.baseUrl ||
		(model.baseUrl && model.baseUrl.length > 0 ? model.baseUrl : undefined) ||
		config?.baseUrl ||
		env("OPENAI_BASE_URL") ||
		DEFAULT_BASE_URL;
	return trimTrailingSlash(raw);
}

function resolveApiKey(options?: StreamOptions, config?: OpenAICompletionsConfig): string | undefined {
	return options?.apiKey || config?.apiKey || env("OPENAI_API_KEY");
}

// ---------------------------------------------------------------------------
// Message + tool conversion
// ---------------------------------------------------------------------------

/** Convert internal Context messages to Chat Completions `messages`. */
export function convertCompletionsMessages(context: Context): CompletionsMessage[] {
	const out: CompletionsMessage[] = [];

	if (context.systemPrompt) {
		out.push({ role: "system", content: context.systemPrompt });
	}

	for (const msg of context.messages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				out.push({ role: "user", content: msg.content });
			} else {
				const content: CompletionsUserContent[] = [];
				for (const item of msg.content) {
					if (item.type === "text") {
						content.push({ type: "text", text: item.text });
					} else if (item.type === "image") {
						content.push({
							type: "image_url",
							image_url: { url: `data:${item.mimeType};base64,${item.data}` },
						});
					}
				}
				if (content.length > 0) {
					out.push({ role: "user", content });
				}
			}
		} else if (msg.role === "assistant") {
			const text = msg.content
				.filter((b): b is TextContent => b.type === "text")
				.map((b) => b.text)
				.join("");
			const toolCalls = msg.content.filter(
				(b): b is Extract<typeof b, { type: "toolCall" }> => b.type === "toolCall",
			);
			const entry: Extract<CompletionsMessage, { role: "assistant" }> = {
				role: "assistant",
				content: text.length > 0 ? text : null,
			};
			// Thinking blocks are not replayed on the completions wire.
			if (toolCalls.length > 0) {
				entry.tool_calls = toolCalls.map((call) => ({
					id: normalizeToolCallIdParts(call.id).callId,
					type: "function",
					function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
				}));
			}
			if (entry.content !== null || entry.tool_calls) {
				out.push(entry);
			}
		} else if (msg.role === "toolResult") {
			out.push({
				role: "tool",
				tool_call_id: normalizeToolCallIdParts(msg.toolCallId).callId,
				content: toolResultText(msg),
			});
		}
	}

	return out;
}

/** Convert internal tools to Chat Completions function tools. */
export function convertCompletionsTools(tools: readonly Tool[]): CompletionsTool[] {
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		},
	}));
}

const REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high"]);

export function buildCompletionsBody(
	model: Model,
	context: Context,
	options?: OpenAICompletionsStreamOptions,
): CompletionsCreateBody {
	const messages = convertCompletionsMessages(context);
	const body: CompletionsCreateBody = {
		model: model.id,
		messages,
		stream: true,
		stream_options: { include_usage: true },
	};

	// samplingParams may add top_p / penalties / etc. Applied before named options
	// and before re-asserting the streaming contract fields below.
	if (options?.samplingParams) {
		Object.assign(body, options.samplingParams);
	}

	if (context.tools && context.tools.length > 0) {
		body.tools = convertCompletionsTools(context.tools);
	}

	if (options?.maxTokens !== undefined) {
		body.max_tokens = options.maxTokens;
	}

	if (options?.temperature !== undefined) {
		body.temperature = options.temperature;
	}

	if (options?.reasoning && REASONING_EFFORTS.has(options.reasoning)) {
		body.reasoning_effort = options.reasoning;
	}

	// Force critical wire fields so samplingParams cannot disable streaming or rewrite messages.
	body.model = model.id;
	body.messages = messages;
	body.stream = true;

	return body;
}

// ---------------------------------------------------------------------------
// Stream event → internal events
// ---------------------------------------------------------------------------

type OutputSlot =
	| { kind: "text"; block: TextContent; contentIndex: number }
	| { kind: "thinking"; block: ThinkingContent; contentIndex: number }
	| { kind: "toolCall"; block: StreamingToolCall; contentIndex: number };

function applyUsage(output: AssistantMessage, usage: NonNullable<CompletionsChunk["usage"]>): void {
	const cachedTokens = usage.prompt_tokens_details?.cached_tokens || 0;
	const next: Usage = {
		input: Math.max(0, (usage.prompt_tokens || 0) - cachedTokens),
		output: usage.completion_tokens || 0,
		cacheRead: cachedTokens,
		cacheWrite: 0,
		reasoning: usage.completion_tokens_details?.reasoning_tokens || 0,
		totalTokens: usage.total_tokens || 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	output.usage = next;
}

function mapFinishReason(reason: string | null | undefined): { stopReason: StopReason; errorMessage?: string } {
	switch (reason) {
		case "stop":
			return { stopReason: "stop" };
		case "length":
		case "max_tokens":
			return { stopReason: "length" };
		case "tool_calls":
		case "function_call":
			return { stopReason: "toolUse" };
		case "content_filter":
			return { stopReason: "error", errorMessage: "Response stopped by content filter" };
		default:
			return { stopReason: "stop" };
	}
}

async function processCompletionsEvents(
	events: AsyncIterable<CompletionsChunk>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	signal?: AbortSignal,
): Promise<void> {
	const slots = new Map<number, OutputSlot>();
	let sawFinish = false;
	/** Set when a tool call's arguments JSON is invalid; applied after terminal mapping. */
	let toolArgsError: string | undefined;

	const getTextSlot = (): Extract<OutputSlot, { kind: "text" }> => {
		const slot = slots.get(0);
		if (slot?.kind === "text") return slot;
		const block: TextContent = { type: "text", text: "" };
		output.content.push(block);
		const next: OutputSlot = { kind: "text", block, contentIndex: output.content.length - 1 };
		slots.set(0, next);
		stream.push({ type: "text_start", contentIndex: next.contentIndex, partial: output });
		return next as Extract<OutputSlot, { kind: "text" }>;
	};

	const getThinkingSlot = (): Extract<OutputSlot, { kind: "thinking" }> => {
		const slot = slots.get(-1);
		if (slot?.kind === "thinking") return slot;
		const block: ThinkingContent = { type: "thinking", thinking: "" };
		output.content.push(block);
		const next: OutputSlot = { kind: "thinking", block, contentIndex: output.content.length - 1 };
		slots.set(-1, next);
		stream.push({ type: "thinking_start", contentIndex: next.contentIndex, partial: output });
		return next as Extract<OutputSlot, { kind: "thinking" }>;
	};

	const getToolCallSlot = (index: number): { slot: Extract<OutputSlot, { kind: "toolCall" }>; created: boolean } => {
		const slot = slots.get(index);
		if (slot?.kind === "toolCall") {
			return { slot, created: false };
		}
		const block: StreamingToolCall = {
			type: "toolCall",
			id: `call_${index}`,
			name: "",
			arguments: {},
			partialJson: "",
		};
		output.content.push(block);
		const next: OutputSlot = { kind: "toolCall", block, contentIndex: output.content.length - 1 };
		slots.set(index, next);
		stream.push({ type: "toolcall_start", contentIndex: next.contentIndex, partial: output });
		return { slot: next as Extract<OutputSlot, { kind: "toolCall" }>, created: true };
	};

	const closeSlots = (): void => {
		for (const [key, slot] of [...slots.entries()].sort((a, b) => a[0] - b[0])) {
			if (slot.kind === "text") {
				stream.push({
					type: "text_end",
					contentIndex: slot.contentIndex,
					content: slot.block.text,
					partial: output,
				});
			} else if (slot.kind === "thinking") {
				stream.push({
					type: "thinking_end",
					contentIndex: slot.contentIndex,
					content: slot.block.thinking,
					partial: output,
				});
			} else {
				const parseError = applyParsedToolArguments(slot.block, slot.block.partialJson || "{}");
				if (parseError) {
					toolArgsError = toolArgsError ?? parseError;
				}
				delete slot.block.partialJson;
				stream.push({
					type: "toolcall_end",
					contentIndex: slot.contentIndex,
					toolCall: {
						type: "toolCall",
						id: slot.block.id,
						name: slot.block.name,
						arguments: slot.block.arguments,
					},
					partial: output,
				});
			}
			slots.delete(key);
		}
	};

	for await (const chunk of events) {
		if (signal?.aborted) {
			throw new DOMException("The operation was aborted.", "AbortError");
		}

		if (chunk.error) {
			throw new Error(chunk.error.message || chunk.error.code || "Unknown stream error");
		}

		if (chunk.usage) {
			applyUsage(output, chunk.usage);
		}

		const choice = chunk.choices?.[0];
		if (!choice) continue;
		const delta = choice.delta;

		if (delta?.reasoning_content) {
			const slot = getThinkingSlot();
			slot.block.thinking += delta.reasoning_content;
			stream.push({
				type: "thinking_delta",
				contentIndex: slot.contentIndex,
				delta: delta.reasoning_content,
				partial: output,
			});
		}

		if (delta?.content) {
			const slot = getTextSlot();
			slot.block.text += delta.content;
			stream.push({ type: "text_delta", contentIndex: slot.contentIndex, delta: delta.content, partial: output });
		}

		for (const call of delta?.tool_calls ?? []) {
			const index = (call.index ?? 0) + 1; // tool call slots start at 1; 0 is text
			const { slot } = getToolCallSlot(index);
			if (call.id) {
				slot.block.id = call.id;
			}
			if (call.function?.name) {
				slot.block.name += call.function.name;
			}
			if (call.function?.arguments) {
				slot.block.partialJson = (slot.block.partialJson ?? "") + call.function.arguments;
				stream.push({
					type: "toolcall_delta",
					contentIndex: slot.contentIndex,
					delta: call.function.arguments,
					partial: output,
				});
			}
		}

		if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
			sawFinish = true;
			closeSlots();
			const mapped = mapFinishReason(choice.finish_reason);
			output.stopReason = mapped.stopReason;
			if (mapped.errorMessage) {
				output.errorMessage = mapped.errorMessage;
			}
		}
	}

	if (!sawFinish) {
		throw new Error("Chat Completions stream ended before a finish_reason");
	}

	// Invalid tool JSON wins over toolUse so the agent does not execute empty args.
	if (toolArgsError) {
		output.stopReason = "error";
		output.errorMessage = toolArgsError;
		return;
	}
	if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
		output.stopReason = "toolUse";
	}
}

function stripScratch(output: AssistantMessage): void {
	for (const block of output.content) {
		if (block.type === "toolCall") {
			delete (block as StreamingToolCall).partialJson;
		}
	}
}

// ---------------------------------------------------------------------------
// Public StreamFn surface
// ---------------------------------------------------------------------------

/**
 * Stream one turn via OpenAI Chat Completions API.
 *
 * Never throws for business/request failures once invoked; encodes them on the
 * final AssistantMessage (`stopReason` `"error"` | `"aborted"`).
 */
export function streamOpenAICompletions(
	model: Model,
	context: Context,
	options?: OpenAICompletionsStreamOptions,
	config?: OpenAICompletionsConfig,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const output = createPendingOutput(model);
	const signal = options?.signal;
	const http = resolveHttpConfig(config);
	// Idle timeouts abort this child signal — the caller signal stays clean so
	// isAbortError(error, signal) still distinguishes user abort from timeout.
	const linked = linkAbort(signal);
	let idleError: StreamTimeoutError | undefined;

	void (async () => {
		try {
			if (signal?.aborted) {
				throw new DOMException("The operation was aborted.", "AbortError");
			}

			const apiKey = resolveApiKey(options, config);
			if (!apiKey) {
				throw new Error(
					"No API key for OpenAI Completions. Pass options.apiKey, createOpenAICompletionsStream({ apiKey }), or set OPENAI_API_KEY.",
				);
			}

			const baseUrl = resolveBaseUrl(model, options, config);
			const body = buildCompletionsBody(model, context, options);

			const response = await fetchWithRetry({
				fetch: http.fetch,
				url: `${baseUrl}/chat/completions`,
				init: {
					method: "POST",
					headers: {
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
						Accept: "text/event-stream",
					},
					body: JSON.stringify(body),
				},
				policy: http.retry,
				signal,
				headersMs: http.timeouts.headersMs,
				onRetry: http.onRetry,
				httpErrorPrefix: "OpenAI Completions",
			});

			stream.push({ type: "start", partial: output });

			await processCompletionsEvents(
				withIdleTimeout(
					parseSseJson<CompletionsChunk>(response.body, linked.signal),
					http.timeouts.idleMs,
					(error) => {
						idleError = error;
						linked.abort(error);
					},
				),
				output,
				stream,
				signal,
			);

			if (idleError) {
				throw idleError;
			}
			if (signal?.aborted) {
				throw new DOMException("The operation was aborted.", "AbortError");
			}

			stripScratch(output);

			if (output.stopReason === "pending") {
				throw new Error("Chat Completions stream ended without a stop reason");
			}

			if (output.stopReason === "error" || output.stopReason === "aborted") {
				stream.push({ type: "error", reason: output.stopReason, error: output });
				stream.end(output);
				return;
			}

			const reason = output.stopReason as Extract<StopReason, "stop" | "length" | "toolUse">;
			stream.push({ type: "done", reason, message: output });
			stream.end(output);
		} catch (error) {
			stripScratch(output);
			const aborted = idleError === undefined && isAbortError(error, signal);
			output.stopReason = aborted ? "aborted" : "error";
			output.errorMessage = aborted
				? (output.errorMessage ?? "Request was aborted")
				: (idleError?.message ?? formatError(error));
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end(output);
		} finally {
			linked.dispose();
		}
	})();

	return stream;
}

/**
 * Factory: returns a StreamFn bound to optional apiKey / baseUrl / fetch defaults.
 */
export function createOpenAICompletionsStream(config: OpenAICompletionsConfig = {}): StreamFn {
	return (model, context, options) =>
		streamOpenAICompletions(model, context, options as OpenAICompletionsStreamOptions | undefined, config);
}

/** Build a minimal Model for OpenAI Completions (hand-runs / tests). */
export function createOpenAICompletionsModel(
	partial: Partial<
		Pick<Model, "id" | "name" | "baseUrl" | "provider" | "reasoning" | "input" | "contextWindow" | "maxTokens">
	> & {
		id?: string;
	} = {},
): Model {
	const id = partial.id ?? "gpt-4.1";
	return {
		id,
		name: partial.name ?? id,
		api: DEFAULT_API,
		provider: partial.provider ?? DEFAULT_PROVIDER,
		baseUrl: partial.baseUrl ?? env("OPENAI_BASE_URL") ?? DEFAULT_BASE_URL,
		reasoning: partial.reasoning,
		input: partial.input ?? ["text"],
		contextWindow: partial.contextWindow,
		maxTokens: partial.maxTokens,
	};
}
