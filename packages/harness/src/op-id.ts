/**
 * Content-derived op identity (ADR-0030).
 *
 * Op ids and intent hashes come from canonical JSON + sha256 so that two
 * contexts of equal message count do not collide and replay is keyed on what
 * was actually sent, not how long the array was.
 */

import { createHash } from "node:crypto";
import type { Context } from "@z-agent/ai";

/** Strings longer than this are replaced by a digest marker in canonical form. */
const LONG_STRING_THRESHOLD = 8192;

export function sha256Hex(input: string | Uint8Array): string {
	return createHash("sha256").update(input).digest("hex");
}

/**
 * Deterministic JSON: keys sorted recursively, `undefined` dropped, arrays in
 * order. Long strings and byte arrays are replaced by digest markers so the
 * canonical string stays bounded for image-heavy contexts.
 */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
	if (value === undefined || typeof value === "function" || typeof value === "symbol") {
		return undefined;
	}
	if (value === null || typeof value !== "object") {
		if (typeof value === "string" && value.length > LONG_STRING_THRESHOLD) {
			return { $sha256: sha256Hex(value), $length: value.length };
		}
		return value;
	}
	if (value instanceof Uint8Array) {
		return { $bytes: sha256Hex(value), $byteLength: value.byteLength };
	}
	if (Array.isArray(value)) {
		return value.map((item) => canonicalize(item));
	}
	const record = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(record).sort()) {
		const item = canonicalize(record[key]);
		if (item !== undefined) {
			out[key] = item;
		}
	}
	return out;
}

/** sha256 of the canonical intent payload. */
export function intentHash(intent: unknown): string {
	return sha256Hex(canonicalJson(intent));
}

export function toolOpId(toolCallId: string): string {
	return `tool:${toolCallId}`;
}

/**
 * Stream op id keyed by session plus a content hash of everything the provider
 * would see: model id/api, system prompt, tool surface, and messages.
 * StreamOptions (signal, apiKey, sampling) are deliberately excluded.
 */
export function streamOpId(input: { sessionId?: string; modelId: string; api: string; context: Context }): {
	opId: string;
	contextHash: string;
} {
	const contextHash = sha256Hex(
		canonicalJson({
			modelId: input.modelId,
			api: input.api,
			systemPrompt: input.context.systemPrompt,
			tools: input.context.tools,
			messages: input.context.messages,
		}),
	);
	return {
		opId: `stream:${input.sessionId ?? "anon"}:${contextHash.slice(0, 32)}`,
		contextHash,
	};
}
