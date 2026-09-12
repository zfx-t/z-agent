/**
 * Helpers shared by provider stream adapters (openai-responses,
 * openai-completions, anthropic-messages).
 */

import { DEFAULT_RETRY_POLICY, type OnRetry, type RetryPolicy } from "./retry.ts";
import { DEFAULT_STREAM_TIMEOUTS, type StreamTimeouts } from "./timeouts.ts";
import type { AssistantMessage, Message, ToolCall } from "./types.ts";
import { emptyUsage } from "./types.ts";

export { httpErrorMessage } from "./retry.ts";

export function env(name: string): string | undefined {
	try {
		const value = globalThis.process?.env?.[name];
		return typeof value === "string" && value.length > 0 ? value : undefined;
	} catch {
		return undefined;
	}
}

export function trimTrailingSlash(url: string): string {
	return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * Per-factory HTTP behaviour for provider adapters. `retry: false` disables
 * retry entirely; partial policy/timeouts merge over the defaults.
 */
export interface ProviderHttpConfig {
	/** Injected fetch (tests). Defaults to globalThis.fetch. */
	fetch?: typeof globalThis.fetch;
	retry?: Partial<RetryPolicy> | false;
	timeouts?: Partial<StreamTimeouts>;
	onRetry?: OnRetry;
}

export interface ResolvedHttpConfig {
	fetch: typeof globalThis.fetch;
	retry: RetryPolicy | false;
	timeouts: StreamTimeouts;
	onRetry?: OnRetry;
}

export function resolveHttpConfig(config?: ProviderHttpConfig): ResolvedHttpConfig {
	return {
		fetch: config?.fetch ?? globalThis.fetch.bind(globalThis),
		retry: config?.retry === false ? false : { ...DEFAULT_RETRY_POLICY, ...config?.retry },
		timeouts: { ...DEFAULT_STREAM_TIMEOUTS, ...config?.timeouts },
		onRetry: config?.onRetry,
	};
}

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
	if (signal?.aborted) return true;
	if (error instanceof DOMException && error.name === "AbortError") return true;
	if (error instanceof Error && error.name === "AbortError") return true;
	return false;
}

export function formatError(error: unknown): string {
	if (error instanceof Error) return error.message || error.name;
	return String(error);
}

export function createPendingOutput(model: { api: string; provider: string; id: string }): AssistantMessage {
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

/** Streaming tool call scratch: partial JSON accumulates until toolcall_end. */
export type StreamingToolCall = ToolCall & { partialJson?: string };

export type ParseToolArgsResult = { ok: true; args: Record<string, unknown> } | { ok: false; error: string };

export function parseToolArguments(json: string): ParseToolArgsResult {
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

export function applyParsedToolArguments(block: StreamingToolCall, argsJson: string): string | undefined {
	const parsed = parseToolArguments(argsJson);
	if (parsed.ok) {
		block.arguments = parsed.args;
		return undefined;
	}
	block.arguments = {};
	return parsed.error;
}

/**
 * Tool call ids may carry a provider item id suffix (`call_x|fc_y` from
 * Responses). Providers that only know the call id use the part before `|`.
 */
export function normalizeToolCallIdParts(id: string): { callId: string; itemId?: string } {
	const pipe = id.indexOf("|");
	if (pipe === -1) {
		return { callId: id };
	}
	return { callId: id.slice(0, pipe), itemId: id.slice(pipe + 1) || undefined };
}

/** Flatten tool result content; agent errors surface as an "Error:" prefix on the wire. */
export function toolResultText(msg: Extract<Message, { role: "toolResult" }>): string {
	const parts = msg.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text);
	let text: string;
	if (parts.length > 0) {
		text = parts.join("\n");
	} else {
		const hasImage = msg.content.some((c) => c.type === "image");
		text = hasImage ? "(see attached image)" : "(no tool output)";
	}
	if (msg.isError && !text.startsWith("Error:")) {
		return `Error: ${text}`;
	}
	return text;
}
