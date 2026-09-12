/**
 * Bounded provider-request retry (ADR-0028).
 *
 * `fetchWithRetry` wraps only the fetch call and the `response.ok` check.
 * Once an ok response exists the adapter owns the stream — retry past that
 * point would duplicate partial output, so it is impossible by construction.
 *
 * Retryable: HTTP 408/409/425/429/500/502/503/504, network errors thrown by
 * fetch, and headers timeouts. Caller abort wins at every point.
 */

import { StreamTimeoutError, withHeadersTimeout } from "./timeouts.ts";

export interface RetryPolicy {
	maxAttempts: number;
	baseDelayMs: number;
	maxDelayMs: number;
	retryableStatuses: ReadonlySet<number>;
}

export const DEFAULT_RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
	maxAttempts: 3,
	baseDelayMs: 500,
	maxDelayMs: 8_000,
	retryableStatuses: DEFAULT_RETRYABLE_STATUSES,
};

export interface RetryEvent {
	/** 1-based attempt that just failed. */
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	/** "HTTP 429" | "network: ECONNRESET" | "headers timeout" */
	reason: string;
}

export type OnRetry = (event: RetryEvent) => void;
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

function abortError(): DOMException {
	return new DOMException("The operation was aborted.", "AbortError");
}

const defaultSleep: Sleep = (ms, signal) =>
	new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError());
			return;
		}
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			cleanup();
			reject(abortError());
		};
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});

/** Parse a Retry-After header (integer seconds or HTTP-date) into ms. */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | undefined {
	if (!header) {
		return undefined;
	}
	const trimmed = header.trim();
	if (/^\d+$/u.test(trimmed)) {
		return Number(trimmed) * 1000;
	}
	// IMF-fixdate always ends in GMT; reject Date.parse leniency ("2.5", "Mar 3", …).
	if (!/GMT$/iu.test(trimmed)) {
		return undefined;
	}
	const date = Date.parse(trimmed);
	if (Number.isNaN(date)) {
		return undefined;
	}
	return Math.max(0, date - now);
}

/**
 * Exponential backoff: `min(maxDelayMs, baseDelayMs * 2^(attempt-1)) * jitter`
 * with jitter uniform in [0.5, 1.5). `attempt` is the 1-based failed attempt.
 */
export function computeBackoff(attempt: number, policy: RetryPolicy, random: () => number = Math.random): number {
	const jitter = 0.5 + random();
	return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1)) * jitter;
}

const RETRYABLE_NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN"]);

/** fetch network failures are TypeError; Node errors may carry code on the error or its cause. */
export function isRetryableNetworkError(error: unknown): boolean {
	if (error instanceof TypeError) {
		return true;
	}
	if (typeof error !== "object" || error === null) {
		return false;
	}
	const code = (error as { code?: unknown }).code;
	if (typeof code === "string" && RETRYABLE_NETWORK_CODES.has(code)) {
		return true;
	}
	const cause = (error as { cause?: unknown }).cause;
	if (typeof cause === "object" && cause !== null) {
		const causeCode = (cause as { code?: unknown }).code;
		return typeof causeCode === "string" && RETRYABLE_NETWORK_CODES.has(causeCode);
	}
	return false;
}

function networkReason(error: unknown): string {
	if (typeof error === "object" && error !== null) {
		const code = (error as { code?: unknown }).code ?? (error as { cause?: { code?: unknown } }).cause?.code;
		if (typeof code === "string") {
			return code;
		}
	}
	return error instanceof Error ? error.message : String(error);
}

/**
 * `<prefix> HTTP <status> <statusText>: <body detail>` — detail truncated to
 * 500 chars; a body read failure yields the status line alone.
 */
export async function httpErrorMessage(prefix: string, response: Response): Promise<string> {
	let detail = "";
	try {
		detail = (await response.text()).slice(0, 500);
	} catch {
		// ignore body read failure
	}
	return `${prefix} HTTP ${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`;
}

export interface FetchWithRetryInput {
	fetch: typeof globalThis.fetch;
	url: string;
	init: RequestInit;
	policy: RetryPolicy | false;
	signal?: AbortSignal;
	headersMs: number;
	onRetry?: OnRetry;
	sleep?: Sleep;
	random?: () => number;
	/** Adapter label prepended to terminal HTTP error messages (e.g. "OpenAI Responses HTTP 503 …"). */
	httpErrorPrefix?: string;
}

/** Resolves with an ok response, or throws the final error (HTTP / network / timeout). */
export async function fetchWithRetry(input: FetchWithRetryInput): Promise<Response> {
	const policy = input.policy === false ? undefined : input.policy;
	const maxAttempts = Math.max(1, policy?.maxAttempts ?? 1);
	const sleep = input.sleep ?? defaultSleep;
	const random = input.random ?? Math.random;
	const prefix = input.httpErrorPrefix ?? "HTTP";

	for (let attempt = 1; ; attempt++) {
		if (input.signal?.aborted) {
			throw abortError();
		}
		let retry: { delayMs: number; reason: string } | undefined;
		try {
			const response = await withHeadersTimeout(
				(attemptSignal) => input.fetch(input.url, { ...input.init, signal: attemptSignal }),
				input.headersMs,
				input.signal,
			);
			if (response.ok) {
				return response;
			}
			if (policy && attempt < maxAttempts && policy.retryableStatuses.has(response.status)) {
				// Free the connection for keep-alive reuse instead of waiting for GC.
				await response.body?.cancel().catch(() => {});
				const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
				retry = {
					delayMs:
						retryAfter !== undefined
							? Math.min(policy.maxDelayMs, retryAfter)
							: computeBackoff(attempt, policy, random),
					reason: `HTTP ${response.status}`,
				};
			} else {
				const message = await httpErrorMessage(prefix, response);
				throw new Error(attempt > 1 ? `${message} after ${attempt} attempts` : message);
			}
		} catch (error) {
			if (input.signal?.aborted) {
				throw abortError();
			}
			if (error instanceof StreamTimeoutError && error.phase === "headers") {
				if (policy && attempt < maxAttempts) {
					retry = { delayMs: computeBackoff(attempt, policy, random), reason: "headers timeout" };
				} else {
					throw error;
				}
			} else if (isRetryableNetworkError(error)) {
				if (policy && attempt < maxAttempts) {
					retry = {
						delayMs: computeBackoff(attempt, policy, random),
						reason: `network: ${networkReason(error)}`,
					};
				} else {
					throw error;
				}
			} else {
				throw error;
			}
		}
		if (retry) {
			input.onRetry?.({ attempt, maxAttempts, delayMs: retry.delayMs, reason: retry.reason });
			await sleep(retry.delayMs, input.signal);
		}
	}
}
