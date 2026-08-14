/**
 * OpenAI Responses API stream adapter (ADR-0005).
 *
 * Clean-room production HTTP path: POST /responses with stream:true, parse SSE,
 * normalize vendor events into AssistantMessageEventStream.
 *
 * Text + function tools + reasoning items (thinking SSE + signature replay).
 * Failures are encoded on the final AssistantMessage — StreamFn never throws for
 * business/request failures once invoked.
 *
 * Env sketch (optional; no dotenv): OPENAI_API_KEY, OPENAI_BASE_URL.
 */

import type { AssistantMessageEventStream } from "./event-stream.ts";
import { createAssistantMessageEventStream } from "./event-stream.ts";
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
	Tool,
	ToolCall,
	Usage,
} from "./types.ts";
import { emptyUsage } from "./types.ts";

// ---------------------------------------------------------------------------
// Constants + config
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_API = "openai-responses";
const DEFAULT_PROVIDER = "openai";
/** OpenAI Responses rejects max_output_tokens below 16. */
const MIN_OUTPUT_TOKENS = 16;

export interface OpenAIResponsesConfig {
	/** Default API key when StreamOptions.apiKey is omitted. Falls back to OPENAI_API_KEY. */
	apiKey?: string;
	/**
	 * Default base URL when Model.baseUrl is empty/missing.
	 * Falls back to OPENAI_BASE_URL, then https://api.openai.com/v1.
	 */
	baseUrl?: string;
	/** Injected fetch (tests). Defaults to globalThis.fetch. */
	fetch?: typeof globalThis.fetch;
}

export interface OpenAIResponsesStreamOptions extends StreamOptions {
	/** Override base URL for this call (else model.baseUrl / config / env). */
	baseUrl?: string;
}

// ---------------------------------------------------------------------------
// Wire types (minimal Responses subset — not the full OpenAI SDK)
// ---------------------------------------------------------------------------

type ResponsesRole = "system" | "developer" | "user" | "assistant";

interface ResponsesInputText {
	type: "input_text";
	text: string;
}

interface ResponsesInputImage {
	type: "input_image";
	detail: "auto";
	image_url: string;
}

type ResponsesInputContent = ResponsesInputText | ResponsesInputImage;

interface ResponsesEasyMessage {
	role: ResponsesRole;
	content: string | ResponsesInputContent[];
}

interface ResponsesOutputText {
	type: "output_text";
	text: string;
	annotations: unknown[];
}

interface ResponsesRefusal {
	type: "refusal";
	refusal: string;
}

interface ResponsesAssistantMessageItem {
	type: "message";
	role: "assistant";
	content: Array<ResponsesOutputText | ResponsesRefusal>;
	status: "completed";
	id: string;
}

interface ResponsesFunctionCallItem {
	type: "function_call";
	id?: string;
	call_id: string;
	name: string;
	arguments: string;
}

interface ResponsesFunctionCallOutput {
	type: "function_call_output";
	call_id: string;
	output: string;
}

interface ResponsesReasoningItem {
	type: "reasoning";
	id?: string;
	summary?: unknown;
	content?: unknown;
	encrypted_content?: string;
}

type ResponsesInputItem =
	| ResponsesEasyMessage
	| ResponsesAssistantMessageItem
	| ResponsesFunctionCallItem
	| ResponsesFunctionCallOutput
	| ResponsesReasoningItem;

interface ResponsesFunctionTool {
	type: "function";
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	strict: boolean;
}

interface ResponsesCreateBody {
	model: string;
	input: ResponsesInputItem[];
	stream: true;
	store: false;
	tools?: ResponsesFunctionTool[];
	temperature?: number;
	max_output_tokens?: number;
	[key: string]: unknown;
}

/** Loose stream event shape — only fields we read. */
interface ResponsesStreamEvent {
	type: string;
	response?: {
		id?: string;
		status?: string;
		usage?: {
			input_tokens?: number;
			output_tokens?: number;
			total_tokens?: number;
			input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
			output_tokens_details?: { reasoning_tokens?: number };
		};
		error?: { code?: string; message?: string };
		incomplete_details?: { reason?: string } | null;
		output?: unknown[];
	};
	output_index?: number;
	item?: {
		type?: string;
		id?: string;
		call_id?: string;
		name?: string;
		arguments?: string;
		status?: string;
		content?: Array<{ type?: string; text?: string; refusal?: string }>;
		phase?: string;
		summary?: unknown;
		encrypted_content?: string;
	};
	delta?: string;
	arguments?: string;
	code?: string;
	message?: string;
}

// ---------------------------------------------------------------------------
// Env / URL helpers
// ---------------------------------------------------------------------------

function env(name: string): string | undefined {
	try {
		const value = globalThis.process?.env?.[name];
		return typeof value === "string" && value.length > 0 ? value : undefined;
	} catch {
		return undefined;
	}
}

function trimTrailingSlash(url: string): string {
	return url.endsWith("/") ? url.slice(0, -1) : url;
}

function resolveBaseUrl(model: Model, options?: OpenAIResponsesStreamOptions, config?: OpenAIResponsesConfig): string {
	const raw =
		options?.baseUrl ||
		(model.baseUrl && model.baseUrl.length > 0 ? model.baseUrl : undefined) ||
		config?.baseUrl ||
		env("OPENAI_BASE_URL") ||
		DEFAULT_BASE_URL;
	return trimTrailingSlash(raw);
}

function resolveApiKey(options?: StreamOptions, config?: OpenAIResponsesConfig): string | undefined {
	return options?.apiKey || config?.apiKey || env("OPENAI_API_KEY");
}

function responsesUrl(baseUrl: string): string {
	return `${trimTrailingSlash(baseUrl)}/responses`;
}

// ---------------------------------------------------------------------------
// Message + tool conversion
// ---------------------------------------------------------------------------

function normalizeToolCallIdParts(id: string): { callId: string; itemId?: string } {
	const pipe = id.indexOf("|");
	if (pipe === -1) {
		return { callId: id };
	}
	return { callId: id.slice(0, pipe), itemId: id.slice(pipe + 1) || undefined };
}

function toolResultText(msg: Extract<Message, { role: "toolResult" }>): string {
	const parts = msg.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text);
	let text: string;
	if (parts.length > 0) {
		text = parts.join("\n");
	} else {
		const hasImage = msg.content.some((c) => c.type === "image");
		text = hasImage ? "(see attached image)" : "(no tool output)";
	}
	// Wire path has no separate is_error flag; surface agent errors in the output string.
	if (msg.isError && !text.startsWith("Error:")) {
		return `Error: ${text}`;
	}
	return text;
}

/** Convert internal Context messages to Responses `input` items. */
export function convertResponsesMessages(context: Context): ResponsesInputItem[] {
	const input: ResponsesInputItem[] = [];

	if (context.systemPrompt) {
		input.push({
			role: "system",
			content: context.systemPrompt,
		});
	}

	let msgIndex = 0;
	for (const msg of context.messages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				input.push({
					role: "user",
					content: [{ type: "input_text", text: msg.content }],
				});
			} else {
				const content: ResponsesInputContent[] = [];
				for (const item of msg.content) {
					if (item.type === "text") {
						content.push({ type: "input_text", text: item.text });
					} else if (item.type === "image") {
						content.push({
							type: "input_image",
							detail: "auto",
							image_url: `data:${item.mimeType};base64,${item.data}`,
						});
					}
				}
				if (content.length === 0) {
					msgIndex++;
					continue;
				}
				input.push({ role: "user", content });
			}
		} else if (msg.role === "assistant") {
			const items: ResponsesInputItem[] = [];
			let textBlockIndex = 0;
			for (const block of msg.content) {
				if (block.type === "text") {
					const fallbackId = textBlockIndex === 0 ? `msg_z_${msgIndex}` : `msg_z_${msgIndex}_${textBlockIndex}`;
					textBlockIndex++;
					const id =
						block.textSignature && block.textSignature.length > 0 && block.textSignature.length <= 64
							? block.textSignature
							: fallbackId;
					items.push({
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: block.text, annotations: [] }],
						status: "completed",
						id,
					});
				} else if (block.type === "toolCall") {
					const { callId, itemId } = normalizeToolCallIdParts(block.id);
					const item: ResponsesFunctionCallItem = {
						type: "function_call",
						call_id: callId,
						name: block.name,
						arguments: JSON.stringify(block.arguments ?? {}),
					};
					if (itemId?.startsWith("fc_")) {
						item.id = itemId;
					}
					items.push(item);
				} else if (block.type === "thinking" && block.thinkingSignature) {
					try {
						const parsed: unknown = JSON.parse(block.thinkingSignature);
						if (parsed && typeof parsed === "object" && (parsed as { type?: string }).type === "reasoning") {
							items.push(parsed as ResponsesReasoningItem);
						}
					} catch {
						// Skip malformed signatures rather than fail the whole convert.
					}
				}
			}
			if (items.length > 0) {
				input.push(...items);
			}
		} else if (msg.role === "toolResult") {
			const { callId } = normalizeToolCallIdParts(msg.toolCallId);
			input.push({
				type: "function_call_output",
				call_id: callId,
				output: toolResultText(msg),
			});
		}
		msgIndex++;
	}

	return input;
}

/** Convert internal tools to Responses function tools. */
export function convertResponsesTools(tools: readonly Tool[]): ResponsesFunctionTool[] {
	return tools.map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		strict: false,
	}));
}

export function buildResponsesBody(
	model: Model,
	context: Context,
	options?: OpenAIResponsesStreamOptions,
): ResponsesCreateBody {
	const input = convertResponsesMessages(context);
	const body: ResponsesCreateBody = {
		model: model.id,
		input,
		stream: true,
		store: false,
	};

	// samplingParams may add top_p / penalties / etc. Applied before named options
	// and before re-asserting the streaming contract fields below.
	if (options?.samplingParams) {
		Object.assign(body, options.samplingParams);
	}

	if (context.tools && context.tools.length > 0) {
		body.tools = convertResponsesTools(context.tools);
	}

	if (options?.maxTokens !== undefined) {
		body.max_output_tokens = Math.max(options.maxTokens, MIN_OUTPUT_TOKENS);
	}

	if (options?.temperature !== undefined) {
		body.temperature = options.temperature;
	}

	if (options?.reasoning) {
		body.reasoning = { effort: options.reasoning };
		body.include = ["reasoning.encrypted_content"];
	}

	// Force critical wire fields so samplingParams cannot disable streaming or rewrite input.
	body.model = model.id;
	body.input = input;
	body.stream = true;
	body.store = false;

	return body;
}

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

/**
 * Parse an SSE byte stream into JSON event objects.
 * Supports `data:` lines (OpenAI Responses) and optional `event:` lines.
 * Ignores `[DONE]`.
 */
export async function* parseResponsesSse(
	body: ReadableStream<Uint8Array> | null,
	signal?: AbortSignal,
): AsyncGenerator<ResponsesStreamEvent> {
	if (!body) {
		throw new Error("Response body is empty");
	}

	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let dataLines: string[] = [];

	const flush = (): ResponsesStreamEvent | undefined => {
		if (dataLines.length === 0) return undefined;
		const raw = dataLines.join("\n").trim();
		dataLines = [];
		if (!raw || raw === "[DONE]") return undefined;
		return JSON.parse(raw) as ResponsesStreamEvent;
	};

	// Unblock a pending read() when AbortSignal fires (custom fetch may ignore body signal).
	const onAbort = (): void => {
		void reader.cancel().catch(() => {});
	};
	if (signal) {
		if (signal.aborted) {
			await reader.cancel().catch(() => {});
			throw new DOMException("The operation was aborted.", "AbortError");
		}
		signal.addEventListener("abort", onAbort, { once: true });
	}

	try {
		while (true) {
			if (signal?.aborted) {
				throw new DOMException("The operation was aborted.", "AbortError");
			}
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			while (true) {
				const newline = buffer.indexOf("\n");
				if (newline === -1) break;
				let line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);

				if (line === "") {
					const event = flush();
					if (event) yield event;
					continue;
				}
				if (line.startsWith(":") || line.startsWith("event:")) {
					continue;
				}
				if (line.startsWith("data:")) {
					dataLines.push(line.slice(5).replace(/^\s/, ""));
				}
			}
		}

		buffer += decoder.decode();
		if (buffer.length > 0) {
			const trailing = buffer.replace(/\r$/, "");
			if (trailing.startsWith("data:")) {
				dataLines.push(trailing.slice(5).replace(/^\s/, ""));
			}
		}
		const last = flush();
		if (last) yield last;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		// Cancel so non-abort error paths do not leave the connection draining until GC.
		try {
			await reader.cancel();
		} catch {
			// already cancelled / closed
		}
		try {
			reader.releaseLock();
		} catch {
			// lock released by cancel()
		}
	}
}

// ---------------------------------------------------------------------------
// Stream event → internal events
// ---------------------------------------------------------------------------

type StreamingToolCall = ToolCall & { partialJson?: string };

type OutputSlot =
	| { kind: "text"; block: TextContent; contentIndex: number }
	| { kind: "thinking"; block: ThinkingContent; contentIndex: number }
	| { kind: "toolCall"; block: StreamingToolCall; contentIndex: number };

type ParseToolArgsResult = { ok: true; args: Record<string, unknown> } | { ok: false; error: string };

function parseToolArguments(json: string): ParseToolArgsResult {
	const trimmed = json.trim();
	if (!trimmed) return { ok: true, args: {} };
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return { ok: true, args: parsed as Record<string, unknown> };
		}
		const kind = Array.isArray(parsed) ? "array" : parsed === null ? "null" : typeof parsed;
		return { ok: false, error: `Tool call arguments must be a JSON object, got ${kind}` };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { ok: false, error: `Invalid tool call arguments JSON: ${detail}` };
	}
}

function applyParsedToolArguments(block: StreamingToolCall, argsJson: string): string | undefined {
	const parsed = parseToolArguments(argsJson);
	if (parsed.ok) {
		block.arguments = parsed.args;
		return undefined;
	}
	block.arguments = {};
	return parsed.error;
}

function mapStopReason(
	status: string | undefined,
	incompleteReason?: string,
): { stopReason: StopReason; errorMessage?: string } {
	if (!status || status === "completed") {
		return { stopReason: "stop" };
	}
	if (status === "incomplete") {
		if (incompleteReason === "max_output_tokens") {
			return { stopReason: "length" };
		}
		return {
			stopReason: "error",
			errorMessage: incompleteReason
				? `Response incomplete: ${incompleteReason}`
				: "Response incomplete without a provider reason",
		};
	}
	if (status === "failed" || status === "cancelled") {
		return { stopReason: "error", errorMessage: `Response ${status}` };
	}
	// in_progress / queued as terminal is unexpected; treat as stop
	return { stopReason: "stop" };
}

function applyUsage(output: AssistantMessage, usage: NonNullable<ResponsesStreamEvent["response"]>["usage"]): void {
	if (!usage) return;
	const cachedTokens = usage.input_tokens_details?.cached_tokens || 0;
	const cacheWriteTokens = usage.input_tokens_details?.cache_write_tokens || 0;
	const next: Usage = {
		input: Math.max(0, (usage.input_tokens || 0) - cachedTokens - cacheWriteTokens),
		output: usage.output_tokens || 0,
		cacheRead: cachedTokens,
		cacheWrite: cacheWriteTokens,
		reasoning: usage.output_tokens_details?.reasoning_tokens || 0,
		totalTokens: usage.total_tokens || 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	output.usage = next;
}

function stripScratch(output: AssistantMessage): void {
	for (const block of output.content) {
		if (block.type === "toolCall") {
			delete (block as StreamingToolCall).partialJson;
		}
	}
}

async function processResponsesEvents(
	events: AsyncIterable<ResponsesStreamEvent>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	signal?: AbortSignal,
): Promise<void> {
	const slots = new Map<number, OutputSlot>();
	let sawTerminal = false;
	/** Set when function_call arguments JSON is invalid; applied after terminal mapping. */
	let toolArgsError: string | undefined;

	const createSlot = (
		outputIndex: number,
		item: NonNullable<ResponsesStreamEvent["item"]>,
	): OutputSlot | undefined => {
		if (item.type === "message") {
			const block: TextContent = { type: "text", text: "" };
			output.content.push(block);
			const slot: OutputSlot = { kind: "text", block, contentIndex: output.content.length - 1 };
			slots.set(outputIndex, slot);
			stream.push({ type: "text_start", contentIndex: slot.contentIndex, partial: output });
			return slot;
		}
		if (item.type === "function_call") {
			const callId = item.call_id ?? `call_${outputIndex}`;
			const itemId = item.id;
			const block: StreamingToolCall = {
				type: "toolCall",
				id: itemId ? `${callId}|${itemId}` : callId,
				name: item.name ?? "",
				arguments: {},
				partialJson: item.arguments || "",
			};
			output.content.push(block);
			const slot: OutputSlot = { kind: "toolCall", block, contentIndex: output.content.length - 1 };
			slots.set(outputIndex, slot);
			stream.push({ type: "toolcall_start", contentIndex: slot.contentIndex, partial: output });
			return slot;
		}
		if (item.type === "reasoning") {
			const block: ThinkingContent = { type: "thinking", thinking: "" };
			output.content.push(block);
			const slot: OutputSlot = { kind: "thinking", block, contentIndex: output.content.length - 1 };
			slots.set(outputIndex, slot);
			stream.push({ type: "thinking_start", contentIndex: slot.contentIndex, partial: output });
			return slot;
		}
		return undefined;
	};

	const getSlot = <K extends OutputSlot["kind"]>(
		outputIndex: number,
		kind: K,
	): Extract<OutputSlot, { kind: K }> | undefined => {
		const slot = slots.get(outputIndex);
		return slot?.kind === kind ? (slot as Extract<OutputSlot, { kind: K }>) : undefined;
	};

	const endToolCallSlot = (slot: Extract<OutputSlot, { kind: "toolCall" }>, argsJson: string): void => {
		const parseError = applyParsedToolArguments(slot.block, argsJson);
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

	/** Close slots that never received `output_item.done` before a terminal response event. */
	const closeOpenSlots = (): void => {
		for (const [outputIndex, slot] of [...slots.entries()]) {
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
				endToolCallSlot(slot, slot.block.partialJson || "{}");
			}
			slots.delete(outputIndex);
		}
	};

	const finalizeResponse = (response: NonNullable<ResponsesStreamEvent["response"]>): void => {
		sawTerminal = true;
		closeOpenSlots();
		if (response.id) {
			output.responseId = response.id;
		}
		applyUsage(output, response.usage);
		const incompleteReason =
			typeof response.incomplete_details?.reason === "string" ? response.incomplete_details.reason : undefined;
		const mapped = mapStopReason(response.status, incompleteReason);
		output.stopReason = mapped.stopReason;
		if (mapped.errorMessage) {
			output.errorMessage = mapped.errorMessage;
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
	};

	for await (const event of events) {
		if (signal?.aborted) {
			throw new DOMException("The operation was aborted.", "AbortError");
		}

		switch (event.type) {
			case "response.created": {
				if (event.response?.id) {
					output.responseId = event.response.id;
				}
				break;
			}
			case "response.output_item.added": {
				if (event.item && event.output_index !== undefined) {
					createSlot(event.output_index, event.item);
				}
				break;
			}
			case "response.reasoning_summary_text.delta":
			case "response.reasoning_text.delta": {
				if (event.output_index === undefined || event.delta === undefined) break;
				const slot = getSlot(event.output_index, "thinking");
				if (!slot) break;
				slot.block.thinking += event.delta;
				stream.push({
					type: "thinking_delta",
					contentIndex: slot.contentIndex,
					delta: event.delta,
					partial: output,
				});
				break;
			}
			case "response.output_text.delta":
			case "response.refusal.delta": {
				if (event.output_index === undefined || event.delta === undefined) break;
				const slot = getSlot(event.output_index, "text");
				if (!slot) break;
				slot.block.text += event.delta;
				stream.push({
					type: "text_delta",
					contentIndex: slot.contentIndex,
					delta: event.delta,
					partial: output,
				});
				break;
			}
			case "response.function_call_arguments.delta": {
				if (event.output_index === undefined || event.delta === undefined) break;
				const slot = getSlot(event.output_index, "toolCall");
				if (!slot || slot.block.partialJson === undefined) break;
				slot.block.partialJson += event.delta;
				// Args stay {} until toolcall_end (protocol guarantee).
				stream.push({
					type: "toolcall_delta",
					contentIndex: slot.contentIndex,
					delta: event.delta,
					partial: output,
				});
				break;
			}
			case "response.function_call_arguments.done": {
				if (event.output_index === undefined) break;
				const slot = getSlot(event.output_index, "toolCall");
				if (!slot || slot.block.partialJson === undefined) break;
				const previous = slot.block.partialJson;
				const finalArgs = event.arguments ?? previous;
				slot.block.partialJson = finalArgs;
				if (finalArgs.startsWith(previous)) {
					const delta = finalArgs.slice(previous.length);
					if (delta.length > 0) {
						stream.push({
							type: "toolcall_delta",
							contentIndex: slot.contentIndex,
							delta,
							partial: output,
						});
					}
				}
				break;
			}
			case "response.output_item.done": {
				if (event.output_index === undefined || !event.item) break;
				const item = event.item;
				let slot = slots.get(event.output_index);
				if (!slot) {
					slot = createSlot(event.output_index, item);
				}

				if (item.type === "message" && slot?.kind === "text") {
					const text =
						item.content?.map((c) => (c.type === "output_text" ? (c.text ?? "") : (c.refusal ?? ""))).join("") ||
						slot.block.text;
					slot.block.text = text;
					if (item.id) {
						slot.block.textSignature = item.id;
					}
					stream.push({
						type: "text_end",
						contentIndex: slot.contentIndex,
						content: slot.block.text,
						partial: output,
					});
					slots.delete(event.output_index);
				} else if (item.type === "reasoning" && slot?.kind === "thinking") {
					if (typeof event.item === "object" && event.item) {
						slot.block.thinkingSignature = JSON.stringify(event.item);
					}
					stream.push({
						type: "thinking_end",
						contentIndex: slot.contentIndex,
						content: slot.block.thinking,
						partial: output,
					});
					slots.delete(event.output_index);
				} else if (item.type === "function_call" && slot?.kind === "toolCall") {
					const argsJson = item.arguments || slot.block.partialJson || "{}";
					if (item.call_id && item.id) {
						slot.block.id = `${item.call_id}|${item.id}`;
					} else if (item.call_id) {
						slot.block.id = item.call_id;
					}
					if (item.name) {
						slot.block.name = item.name;
					}
					endToolCallSlot(slot, argsJson);
					slots.delete(event.output_index);
				}
				break;
			}
			case "response.completed":
			case "response.incomplete": {
				if (event.response) {
					finalizeResponse(event.response);
				}
				break;
			}
			case "response.failed": {
				sawTerminal = true;
				closeOpenSlots();
				const err = event.response?.error;
				const details = event.response?.incomplete_details;
				const msg = err
					? `${err.code || "unknown"}: ${err.message || "no message"}`
					: details?.reason
						? `incomplete: ${details.reason}`
						: "Unknown error (no error details in response)";
				throw new Error(msg);
			}
			case "error": {
				throw new Error(
					event.message
						? `Error${event.code ? ` Code ${event.code}` : ""}: ${event.message}`
						: "Unknown stream error",
				);
			}
			default:
				// Ignore lifecycle / unused events (in_progress, content_part.*, etc.)
				break;
		}
	}

	if (!sawTerminal) {
		throw new Error("OpenAI Responses stream ended before a terminal response event");
	}

	// Safety net if tool args failed but finalizeResponse was not reached with that path.
	if (toolArgsError && output.stopReason !== "error" && output.stopReason !== "aborted") {
		output.stopReason = "error";
		output.errorMessage = toolArgsError;
	}
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
	if (signal?.aborted) return true;
	if (error instanceof DOMException && error.name === "AbortError") return true;
	if (error instanceof Error && error.name === "AbortError") return true;
	return false;
}

function formatError(error: unknown): string {
	if (error instanceof Error) return error.message || error.name;
	return String(error);
}

function createPendingOutput(model: Model): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

// ---------------------------------------------------------------------------
// Public StreamFn surface
// ---------------------------------------------------------------------------

/**
 * Stream one turn via OpenAI Responses API.
 *
 * Never throws for business/request failures once invoked; encodes them on the
 * final AssistantMessage (`stopReason` `"error"` | `"aborted"`).
 */
export function streamOpenAIResponses(
	model: Model,
	context: Context,
	options?: OpenAIResponsesStreamOptions,
	config?: OpenAIResponsesConfig,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const output = createPendingOutput(model);
	const signal = options?.signal;
	const fetchFn = config?.fetch ?? globalThis.fetch.bind(globalThis);

	void (async () => {
		try {
			if (signal?.aborted) {
				throw new DOMException("The operation was aborted.", "AbortError");
			}

			const apiKey = resolveApiKey(options, config);
			if (!apiKey) {
				throw new Error(
					"No API key for OpenAI Responses. Pass options.apiKey, createOpenAIResponsesStream({ apiKey }), or set OPENAI_API_KEY.",
				);
			}

			const baseUrl = resolveBaseUrl(model, options, config);
			const body = buildResponsesBody(model, context, options);

			const response = await fetchFn(responsesUrl(baseUrl), {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
					Accept: "text/event-stream",
				},
				body: JSON.stringify(body),
				signal,
			});

			if (!response.ok) {
				let detail = "";
				try {
					detail = (await response.text()).slice(0, 500);
				} catch {
					// ignore body read failure
				}
				throw new Error(
					`OpenAI Responses HTTP ${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`,
				);
			}

			stream.push({ type: "start", partial: output });

			await processResponsesEvents(parseResponsesSse(response.body, signal), output, stream, signal);

			if (signal?.aborted) {
				throw new DOMException("The operation was aborted.", "AbortError");
			}

			stripScratch(output);

			if (output.stopReason === "pending") {
				throw new Error("OpenAI Responses stream ended without a stop reason");
			}

			if (output.stopReason === "error" || output.stopReason === "aborted") {
				stream.push({ type: "error", reason: output.stopReason, error: output });
				stream.end(output);
				return;
			}

			// done reasons: stop | length | toolUse
			const reason = output.stopReason as Extract<StopReason, "stop" | "length" | "toolUse">;
			stream.push({ type: "done", reason, message: output });
			stream.end(output);
		} catch (error) {
			stripScratch(output);
			const aborted = isAbortError(error, signal);
			output.stopReason = aborted ? "aborted" : "error";
			output.errorMessage = aborted ? (output.errorMessage ?? "Request was aborted") : formatError(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end(output);
		}
	})();

	return stream;
}

/**
 * Factory: returns a StreamFn bound to optional apiKey / baseUrl / fetch defaults.
 *
 * ```ts
 * const streamFn = createOpenAIResponsesStream({
 *   apiKey: process.env.OPENAI_API_KEY,
 *   baseUrl: process.env.OPENAI_BASE_URL,
 * });
 * ```
 */
export function createOpenAIResponsesStream(config: OpenAIResponsesConfig = {}): StreamFn {
	return (model, context, options) =>
		streamOpenAIResponses(model, context, options as OpenAIResponsesStreamOptions | undefined, config);
}

/** Build a minimal Model for OpenAI Responses (hand-runs / tests). */
export function createOpenAIResponsesModel(
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
