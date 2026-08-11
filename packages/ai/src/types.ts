/**
 * LLM protocol types for @z-agent/ai.
 *
 * Semantic shapes align with the pi oracle (Message / stream events / StreamFn)
 * without importing pi packages. Responses HTTP wire types live in a later PR.
 */

import type { AssistantMessageEventStream } from "./event-stream.ts";

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

export interface TextContent {
	type: "text";
	text: string;
	/** Provider-specific signature / metadata (e.g. OpenAI message id). */
	textSignature?: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
	/** When true, opaque redacted payload is in `thinkingSignature`. */
	redacted?: boolean;
}

export interface ImageContent {
	type: "image";
	/** Base64-encoded image data. */
	data: string;
	mimeType: string;
}

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	thoughtSignature?: string;
	namespace?: string;
}

export type AssistantContent = TextContent | ThinkingContent | ToolCall;
export type UserContent = TextContent | ImageContent;
export type ToolResultContent = TextContent | ImageContent;

// ---------------------------------------------------------------------------
// Usage + stop reasons
// ---------------------------------------------------------------------------

export interface UsageCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Reasoning/thinking tokens when reported; subset of `output`. */
	reasoning?: number;
	totalTokens: number;
	cost: UsageCost;
}

/** Empty usage skeleton (zeroed). */
export function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/**
 * Why an assistant turn finished.
 * - `pending` — still streaming / incomplete
 * - `stop` — normal completion
 * - `length` — max tokens hit (tool batch must fail without execute)
 * - `toolUse` — model requested tool calls
 * - `error` | `aborted` — terminal failures encoded on the message (not thrown)
 */
export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted";

// ---------------------------------------------------------------------------
// Messages (LLM layer — provider boundary)
// ---------------------------------------------------------------------------

export interface UserMessage {
	role: "user";
	content: string | UserContent[];
	timestamp: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: AssistantContent[];
	api: string;
	provider: string;
	model: string;
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	responseId?: string;
	timestamp: number;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: ToolResultContent[];
	details?: unknown;
	/** Usage from the tool execution itself, if available. Not part of main LLM context accounting. */
	usage?: Usage;
	isError: boolean;
	timestamp: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

// ---------------------------------------------------------------------------
// Context + tools (provider request)
// ---------------------------------------------------------------------------

/** JSON-Schema-shaped tool definition at the LLM boundary. */
export interface Tool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface Context {
	systemPrompt?: string;
	messages: Message[];
	tools?: Tool[];
}

// ---------------------------------------------------------------------------
// Model (minimal)
// ---------------------------------------------------------------------------

export interface Model {
	id: string;
	name: string;
	api: string;
	provider: string;
	baseUrl: string;
	/** Whether the model supports extended thinking / reasoning blocks. */
	reasoning?: boolean;
	input?: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
}

// ---------------------------------------------------------------------------
// Stream options + StreamFn
// ---------------------------------------------------------------------------

export interface StreamOptions {
	signal?: AbortSignal;
	apiKey?: string;
	temperature?: number;
	maxTokens?: number;
	sessionId?: string;
	/** Arbitrary sampling params merged into provider requests when supported. */
	samplingParams?: Record<string, unknown>;
}

/**
 * Provider stream contract.
 *
 * - Must return an `AssistantMessageEventStream` (or a Promise of one).
 * - Must **not** throw for business / request / model failures once invoked.
 * - Failures are encoded as a final {@link AssistantMessage} with
 *   `stopReason` `"error"` or `"aborted"` and optional `errorMessage`,
 *   delivered via the stream (`error` event) or as the stream result.
 *
 * The stream class lives in `event-stream.ts` and is re-exported from the package index.
 */
export type StreamFn = (
	model: Model,
	context: Context,
	options?: StreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

// ---------------------------------------------------------------------------
// Assistant stream events
// ---------------------------------------------------------------------------

/**
 * Event protocol for assistant stream turns.
 *
 * Streams emit `start` before partial updates, then terminate with either:
 * - `done` carrying the final successful AssistantMessage, or
 * - `error` carrying the final AssistantMessage with stopReason "error" | "aborted".
 *
 * **Tool-call partials:** `toolcall_delta.delta` is a JSON string fragment. Until
 * `toolcall_end`, `partial.content[i].arguments` may still be `{}` (args are only
 * guaranteed final on `toolcall_end` / terminal events).
 */
export type AssistantMessageEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	| {
			type: "done";
			reason: Extract<StopReason, "stop" | "length" | "toolUse">;
			message: AssistantMessage;
	  }
	| { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };
