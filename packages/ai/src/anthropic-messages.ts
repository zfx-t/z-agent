/**
 * Anthropic Messages stream adapter (ADR-0027).
 *
 * POST {base}/v1/messages with stream:true. Covers Claude models and
 * Anthropic-compatible gateways.
 *
 * Contract identical to the other adapters: failures are encoded on the final
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
	trimTrailingSlash,
} from "./provider-shared.ts";
import { fetchWithRetry } from "./retry.ts";
import { parseSseJson } from "./sse.ts";
import { linkAbort, type StreamTimeoutError, withIdleTimeout } from "./timeouts.ts";
import type {
	AssistantMessage,
	Context,
	Message,
	Model,
	StopReason,
	StreamFn,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ThinkingLevel,
	Tool,
	Usage,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Constants + config
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_API = "anthropic-messages";
const DEFAULT_PROVIDER = "anthropic";
const ANTHROPIC_VERSION = "2023-06-01";
const THINKING_BETA = "interleaved-thinking-2025-05-14";
const DEFAULT_MAX_TOKENS = 4096;
/** Anthropic requires thinking budgets >= 1024 and < max_tokens. */
const MIN_THINKING_BUDGET = 1024;

const THINKING_BUDGETS: Record<Exclude<ThinkingLevel, "off">, number> = {
	minimal: 1024,
	low: 2048,
	medium: 8192,
	high: 16384,
	xhigh: 32768,
	max: 32768,
};

export interface AnthropicMessagesConfig extends ProviderHttpConfig {
	/** Default API key when StreamOptions.apiKey is omitted. Falls back to ANTHROPIC_API_KEY. */
	apiKey?: string;
	/** Default base URL when Model.baseUrl is empty. Falls back to ANTHROPIC_BASE_URL. */
	baseUrl?: string;
}

export interface AnthropicMessagesStreamOptions extends StreamOptions {
	/** Override base URL for this call (else model.baseUrl / config / env). */
	baseUrl?: string;
}

// ---------------------------------------------------------------------------
// Wire types (minimal Messages subset)
// ---------------------------------------------------------------------------

interface AnthropicTextBlock {
	type: "text";
	text: string;
}

interface AnthropicImageBlock {
	type: "image";
	source: { type: "base64"; media_type: string; data: string };
}

interface AnthropicThinkingBlock {
	type: "thinking";
	thinking: string;
	signature: string;
}

interface AnthropicRedactedThinkingBlock {
	type: "redacted_thinking";
	data: string;
}

interface AnthropicToolUseBlock {
	type: "tool_use";
	id: string;
	name: string;
	input: Record<string, unknown>;
}

interface AnthropicToolResultBlock {
	type: "tool_result";
	tool_use_id: string;
	content: Array<AnthropicTextBlock | AnthropicImageBlock>;
	is_error?: boolean;
}

type AnthropicContentBlock =
	| AnthropicTextBlock
	| AnthropicImageBlock
	| AnthropicThinkingBlock
	| AnthropicRedactedThinkingBlock
	| AnthropicToolUseBlock
	| AnthropicToolResultBlock;

interface AnthropicMessage {
	role: "user" | "assistant";
	content: AnthropicContentBlock[];
}

interface AnthropicTool {
	name: string;
	description: string;
	input_schema: Record<string, unknown>;
}

interface AnthropicCreateBody {
	model: string;
	messages: AnthropicMessage[];
	max_tokens: number;
	stream: true;
	system?: string;
	tools?: AnthropicTool[];
	thinking?: { type: "enabled"; budget_tokens: number };
	temperature?: number;
	[key: string]: unknown;
}

interface AnthropicStreamEvent {
	type: string;
	index?: number;
	message?: {
		id?: string;
		usage?: {
			input_tokens?: number;
			output_tokens?: number;
			cache_read_input_tokens?: number;
			cache_creation_input_tokens?: number;
		};
	};
	content_block?: {
		type?: string;
		id?: string;
		name?: string;
		thinking?: string;
		data?: string;
	};
	delta?: {
		type?: string;
		text?: string;
		thinking?: string;
		signature?: string;
		partial_json?: string;
		stop_reason?: string;
	};
	usage?: {
		output_tokens?: number;
		input_tokens?: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
	};
	error?: { type?: string; message?: string };
}

// ---------------------------------------------------------------------------
// URL / key helpers
// ---------------------------------------------------------------------------

function resolveBaseUrl(
	model: Model,
	options?: AnthropicMessagesStreamOptions,
	config?: AnthropicMessagesConfig,
): string {
	const raw =
		options?.baseUrl ||
		(model.baseUrl && model.baseUrl.length > 0 ? model.baseUrl : undefined) ||
		config?.baseUrl ||
		env("ANTHROPIC_BASE_URL") ||
		DEFAULT_BASE_URL;
	return trimTrailingSlash(raw);
}

function resolveApiKey(options?: StreamOptions, config?: AnthropicMessagesConfig): string | undefined {
	return options?.apiKey || config?.apiKey || env("ANTHROPIC_API_KEY");
}

function messagesUrl(baseUrl: string): string {
	return `${trimTrailingSlash(baseUrl)}/v1/messages`;
}

// ---------------------------------------------------------------------------
// Message + tool conversion
// ---------------------------------------------------------------------------

function toolResultBlocks(msg: Extract<Message, { role: "toolResult" }>): AnthropicToolResultBlock {
	const content: Array<AnthropicTextBlock | AnthropicImageBlock> = [];
	for (const block of msg.content) {
		if (block.type === "text") {
			content.push({ type: "text", text: block.text });
		} else if (block.type === "image") {
			content.push({
				type: "image",
				source: { type: "base64", media_type: block.mimeType, data: block.data },
			});
		}
	}
	if (content.length === 0) {
		content.push({ type: "text", text: "(no tool output)" });
	}
	const result: AnthropicToolResultBlock = {
		type: "tool_result",
		tool_use_id: normalizeToolCallIdParts(msg.toolCallId).callId,
		content,
	};
	if (msg.isError) {
		result.is_error = true;
	}
	return result;
}

/**
 * Convert internal Context messages to Anthropic `messages`.
 *
 * Consecutive toolResult messages merge into one user message of tool_result
 * blocks (Anthropic requires every tool_use answered in the next user turn).
 */
export function convertAnthropicMessages(context: Context): AnthropicMessage[] {
	const out: AnthropicMessage[] = [];

	for (const msg of context.messages) {
		if (msg.role === "user") {
			const content: AnthropicContentBlock[] = [];
			if (typeof msg.content === "string") {
				if (msg.content.length > 0) {
					content.push({ type: "text", text: msg.content });
				}
			} else {
				for (const item of msg.content) {
					if (item.type === "text") {
						content.push({ type: "text", text: item.text });
					} else if (item.type === "image") {
						content.push({
							type: "image",
							source: { type: "base64", media_type: item.mimeType, data: item.data },
						});
					}
				}
			}
			if (content.length > 0) {
				out.push({ role: "user", content });
			}
		} else if (msg.role === "assistant") {
			const content: AnthropicContentBlock[] = [];
			for (const block of msg.content) {
				if (block.type === "text") {
					content.push({ type: "text", text: block.text });
				} else if (block.type === "toolCall") {
					content.push({
						type: "tool_use",
						id: normalizeToolCallIdParts(block.id).callId,
						name: block.name,
						input: block.arguments ?? {},
					});
				} else if (block.type === "thinking") {
					// Replaying thinking requires the provider signature verbatim.
					if (block.redacted && block.thinkingSignature) {
						content.push({ type: "redacted_thinking", data: block.thinkingSignature });
					} else if (block.thinkingSignature) {
						content.push({
							type: "thinking",
							thinking: block.thinking,
							signature: block.thinkingSignature,
						});
					}
				}
			}
			if (content.length > 0) {
				out.push({ role: "assistant", content });
			}
		} else if (msg.role === "toolResult") {
			const result = toolResultBlocks(msg);
			const last = out[out.length - 1];
			if (last && last.role === "user" && last.content.every((b) => b.type === "tool_result")) {
				last.content.push(result);
			} else {
				out.push({ role: "user", content: [result] });
			}
		}
	}

	return out;
}

/** Convert internal tools to Anthropic `tools`. */
export function convertAnthropicTools(tools: readonly Tool[]): AnthropicTool[] {
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		input_schema: tool.parameters,
	}));
}

function thinkingBudget(level: Exclude<ThinkingLevel, "off">, maxTokens: number): number | undefined {
	const budget = Math.min(THINKING_BUDGETS[level], maxTokens - 1);
	return budget >= MIN_THINKING_BUDGET ? budget : undefined;
}

export function buildAnthropicBody(
	model: Model,
	context: Context,
	options?: AnthropicMessagesStreamOptions,
): AnthropicCreateBody {
	const maxTokens = options?.maxTokens ?? model.maxTokens ?? DEFAULT_MAX_TOKENS;
	const body: AnthropicCreateBody = {
		model: model.id,
		messages: convertAnthropicMessages(context),
		max_tokens: maxTokens,
		stream: true,
	};

	// samplingParams may add top_p / top_k / etc. Applied before named options
	// and before re-asserting the streaming contract fields below.
	if (options?.samplingParams) {
		Object.assign(body, options.samplingParams);
	}

	if (context.systemPrompt) {
		body.system = context.systemPrompt;
	}
	if (context.tools && context.tools.length > 0) {
		body.tools = convertAnthropicTools(context.tools);
	}
	if (options?.temperature !== undefined) {
		body.temperature = options.temperature;
	}
	if (options?.reasoning) {
		const budget = thinkingBudget(options.reasoning, maxTokens);
		if (budget !== undefined) {
			body.thinking = { type: "enabled", budget_tokens: budget };
		}
	}

	// Force critical wire fields so samplingParams cannot disable streaming or rewrite messages.
	body.model = model.id;
	body.messages = convertAnthropicMessages(context);
	body.stream = true;
	body.max_tokens = maxTokens;

	return body;
}

// ---------------------------------------------------------------------------
// Stream event → internal events
// ---------------------------------------------------------------------------

type OutputSlot =
	| { kind: "text"; block: TextContent; contentIndex: number }
	| { kind: "thinking"; block: ThinkingContent; contentIndex: number }
	| { kind: "toolCall"; block: StreamingToolCall; contentIndex: number };

function applyUsage(
	output: AssistantMessage,
	usage: {
		input_tokens?: number;
		output_tokens?: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
	},
): void {
	// message_delta may omit cache/input fields; keep earlier message_start values.
	const cacheRead = usage.cache_read_input_tokens ?? output.usage.cacheRead;
	const cacheWrite = usage.cache_creation_input_tokens ?? output.usage.cacheWrite;
	const rawInput = usage.input_tokens ?? output.usage.input + output.usage.cacheRead + output.usage.cacheWrite;
	const next: Usage = {
		input: Math.max(0, rawInput - cacheRead - cacheWrite),
		output: usage.output_tokens ?? output.usage.output,
		cacheRead,
		cacheWrite,
		reasoning: output.usage.reasoning,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	next.totalTokens = next.input + next.output + next.cacheRead + next.cacheWrite;
	output.usage = next;
}

function mapStopReason(reason: string | undefined): { stopReason: StopReason; errorMessage?: string } {
	switch (reason) {
		case "end_turn":
		case "stop_sequence":
			return { stopReason: "stop" };
		case "max_tokens":
			return { stopReason: "length" };
		case "tool_use":
			return { stopReason: "toolUse" };
		case "refusal":
		case "pause_turn":
			return { stopReason: "error", errorMessage: `Response stopped: ${reason}` };
		default:
			return { stopReason: "stop" };
	}
}

async function processAnthropicEvents(
	events: AsyncIterable<AnthropicStreamEvent>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	signal?: AbortSignal,
): Promise<void> {
	const slots = new Map<number, OutputSlot>();
	let sawTerminal = false;
	/** Set when a tool call's arguments JSON is invalid; applied after terminal mapping. */
	let toolArgsError: string | undefined;

	const endToolCallSlot = (slot: Extract<OutputSlot, { kind: "toolCall" }>): void => {
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
	};

	for await (const event of events) {
		if (signal?.aborted) {
			throw new DOMException("The operation was aborted.", "AbortError");
		}

		switch (event.type) {
			case "message_start": {
				if (event.message?.usage) {
					applyUsage(output, event.message.usage);
				}
				break;
			}
			case "content_block_start": {
				if (event.index === undefined || !event.content_block) break;
				const block = event.content_block;
				if (block.type === "text") {
					const textBlock: TextContent = { type: "text", text: "" };
					output.content.push(textBlock);
					slots.set(event.index, { kind: "text", block: textBlock, contentIndex: output.content.length - 1 });
					stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
				} else if (block.type === "thinking" || block.type === "redacted_thinking") {
					const thinkingBlock: ThinkingContent = { type: "thinking", thinking: block.thinking ?? "" };
					if (block.type === "redacted_thinking") {
						thinkingBlock.redacted = true;
						thinkingBlock.thinkingSignature = block.data;
					}
					output.content.push(thinkingBlock);
					slots.set(event.index, {
						kind: "thinking",
						block: thinkingBlock,
						contentIndex: output.content.length - 1,
					});
					stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
				} else if (block.type === "tool_use") {
					const toolBlock: StreamingToolCall = {
						type: "toolCall",
						id: block.id ?? `toolu_${event.index}`,
						name: block.name ?? "",
						arguments: {},
						partialJson: "",
					};
					output.content.push(toolBlock);
					slots.set(event.index, {
						kind: "toolCall",
						block: toolBlock,
						contentIndex: output.content.length - 1,
					});
					stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
				}
				break;
			}
			case "content_block_delta": {
				if (event.index === undefined || !event.delta) break;
				const slot = slots.get(event.index);
				if (!slot) break;
				if (event.delta.type === "text_delta" && slot.kind === "text" && event.delta.text) {
					slot.block.text += event.delta.text;
					stream.push({
						type: "text_delta",
						contentIndex: slot.contentIndex,
						delta: event.delta.text,
						partial: output,
					});
				} else if (event.delta.type === "thinking_delta" && slot.kind === "thinking" && event.delta.thinking) {
					slot.block.thinking += event.delta.thinking;
					stream.push({
						type: "thinking_delta",
						contentIndex: slot.contentIndex,
						delta: event.delta.thinking,
						partial: output,
					});
				} else if (event.delta.type === "signature_delta" && slot.kind === "thinking" && event.delta.signature) {
					slot.block.thinkingSignature = (slot.block.thinkingSignature ?? "") + event.delta.signature;
				} else if (
					event.delta.type === "input_json_delta" &&
					slot.kind === "toolCall" &&
					event.delta.partial_json
				) {
					slot.block.partialJson = (slot.block.partialJson ?? "") + event.delta.partial_json;
					stream.push({
						type: "toolcall_delta",
						contentIndex: slot.contentIndex,
						delta: event.delta.partial_json,
						partial: output,
					});
				}
				break;
			}
			case "content_block_stop": {
				if (event.index === undefined) break;
				const slot = slots.get(event.index);
				if (!slot) break;
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
					endToolCallSlot(slot);
				}
				slots.delete(event.index);
				break;
			}
			case "message_delta": {
				if (event.usage) {
					applyUsage(output, event.usage);
				}
				if (event.delta?.stop_reason) {
					const mapped = mapStopReason(event.delta.stop_reason);
					output.stopReason = mapped.stopReason;
					if (mapped.errorMessage) {
						output.errorMessage = mapped.errorMessage;
					}
				}
				break;
			}
			case "message_stop": {
				sawTerminal = true;
				break;
			}
			case "error": {
				throw new Error(event.error?.message || event.error?.type || "Unknown Anthropic stream error");
			}
			default:
				// ping, message lifecycle extras, content_block signatures, etc.
				break;
		}
	}

	if (!sawTerminal) {
		throw new Error("Anthropic stream ended before message_stop");
	}

	// Close any slot the provider left open before message_stop.
	for (const [index, slot] of [...slots.entries()].sort((a, b) => a[0] - b[0])) {
		if (slot.kind === "text") {
			stream.push({ type: "text_end", contentIndex: slot.contentIndex, content: slot.block.text, partial: output });
		} else if (slot.kind === "thinking") {
			stream.push({
				type: "thinking_end",
				contentIndex: slot.contentIndex,
				content: slot.block.thinking,
				partial: output,
			});
		} else {
			endToolCallSlot(slot);
		}
		slots.delete(index);
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
 * Stream one turn via the Anthropic Messages API.
 *
 * Never throws for business/request failures once invoked; encodes them on the
 * final AssistantMessage (`stopReason` `"error"` | `"aborted"`).
 */
export function streamAnthropicMessages(
	model: Model,
	context: Context,
	options?: AnthropicMessagesStreamOptions,
	config?: AnthropicMessagesConfig,
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
					"No API key for Anthropic Messages. Pass options.apiKey, createAnthropicMessagesStream({ apiKey }), or set ANTHROPIC_API_KEY.",
				);
			}

			const baseUrl = resolveBaseUrl(model, options, config);
			const body = buildAnthropicBody(model, context, options);

			const headers: Record<string, string> = {
				"x-api-key": apiKey,
				"anthropic-version": ANTHROPIC_VERSION,
				"Content-Type": "application/json",
				Accept: "text/event-stream",
			};
			if (body.thinking) {
				headers["anthropic-beta"] = THINKING_BETA;
			}

			const response = await fetchWithRetry({
				fetch: http.fetch,
				url: messagesUrl(baseUrl),
				init: {
					method: "POST",
					headers,
					body: JSON.stringify(body),
				},
				policy: http.retry,
				signal,
				headersMs: http.timeouts.headersMs,
				onRetry: http.onRetry,
				httpErrorPrefix: "Anthropic Messages",
			});

			stream.push({ type: "start", partial: output });

			await processAnthropicEvents(
				withIdleTimeout(
					parseSseJson<AnthropicStreamEvent>(response.body, linked.signal),
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
				throw new Error("Anthropic stream ended without a stop reason");
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
export function createAnthropicMessagesStream(config: AnthropicMessagesConfig = {}): StreamFn {
	return (model, context, options) =>
		streamAnthropicMessages(model, context, options as AnthropicMessagesStreamOptions | undefined, config);
}

/** Build a minimal Model for Anthropic Messages (hand-runs / tests). */
export function createAnthropicMessagesModel(
	partial: Partial<
		Pick<Model, "id" | "name" | "baseUrl" | "provider" | "reasoning" | "input" | "contextWindow" | "maxTokens">
	> & {
		id?: string;
	} = {},
): Model {
	const id = partial.id ?? "claude-sonnet-4-5";
	return {
		id,
		name: partial.name ?? id,
		api: DEFAULT_API,
		provider: partial.provider ?? DEFAULT_PROVIDER,
		baseUrl: partial.baseUrl ?? env("ANTHROPIC_BASE_URL") ?? DEFAULT_BASE_URL,
		reasoning: partial.reasoning,
		input: partial.input ?? ["text"],
		contextWindow: partial.contextWindow,
		maxTokens: partial.maxTokens,
	};
}
