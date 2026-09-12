import { afterEach, describe, expect, it, vi } from "vitest";
import {
	computeBackoff,
	DEFAULT_RETRY_POLICY,
	fetchWithRetry,
	httpErrorMessage,
	isRetryableNetworkError,
	parseRetryAfter,
	type RetryEvent,
	type Sleep,
} from "../src/retry.ts";
import { StreamTimeoutError } from "../src/timeouts.ts";

const POLICY = { ...DEFAULT_RETRY_POLICY, baseDelayMs: 100, maxDelayMs: 1_000 };

/** Sleep that records delays and resolves immediately. */
function instantSleep(delays: number[]): Sleep {
	return (ms) => {
		delays.push(ms);
		return Promise.resolve();
	};
}

function httpResponse(status: number, body = ""): Response {
	return new Response(body, { status, statusText: `S${status}` });
}

function queueFetch(...responses: Array<Response | (() => Promise<Response>)>): {
	fetch: typeof globalThis.fetch;
	calls: number;
} {
	const state = { calls: 0 };
	const fetchFn: typeof globalThis.fetch = async () => {
		state.calls += 1;
		const next = responses.shift();
		if (!next) {
			throw new Error("unexpected extra fetch");
		}
		return typeof next === "function" ? next() : next;
	};
	return {
		fetch: fetchFn,
		get calls() {
			return state.calls;
		},
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("parseRetryAfter", () => {
	it("parses integer seconds", () => {
		expect(parseRetryAfter("2")).toBe(2000);
		expect(parseRetryAfter(" 0 ")).toBe(0);
	});

	it("parses an HTTP-date in the future", () => {
		const now = Date.now();
		const date = new Date(now + 3_000).toUTCString();
		const ms = parseRetryAfter(date, now);
		expect(ms).toBeGreaterThan(0);
		expect(ms).toBeLessThanOrEqual(3_000);
	});

	it("clamps past HTTP-dates to 0 and rejects garbage", () => {
		const now = Date.now();
		expect(parseRetryAfter(new Date(now - 5_000).toUTCString(), now)).toBe(0);
		expect(parseRetryAfter("soon")).toBeUndefined();
		expect(parseRetryAfter(null)).toBeUndefined();
		expect(parseRetryAfter("2.5")).toBeUndefined();
	});
});

describe("computeBackoff", () => {
	it("is base * 2^(attempt-1) capped at maxDelayMs with random=0.5", () => {
		const random = () => 0.5;
		expect(computeBackoff(1, POLICY, random)).toBe(100);
		expect(computeBackoff(2, POLICY, random)).toBe(200);
		expect(computeBackoff(3, POLICY, random)).toBe(400);
		expect(computeBackoff(5, POLICY, random)).toBe(1_000); // capped
	});

	it("applies jitter in [0.5, 1.5)", () => {
		const low = computeBackoff(1, POLICY, () => 0);
		const high = computeBackoff(1, POLICY, () => 0.999);
		expect(low).toBe(50);
		expect(high).toBeLessThan(150);
		expect(high).toBeGreaterThan(100);
	});
});

describe("isRetryableNetworkError", () => {
	it("accepts TypeError and coded errors", () => {
		expect(isRetryableNetworkError(new TypeError("fetch failed"))).toBe(true);
		expect(isRetryableNetworkError(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(true);
		expect(isRetryableNetworkError(Object.assign(new Error("x"), { cause: { code: "EAI_AGAIN" } }))).toBe(true);
		expect(isRetryableNetworkError(new Error("plain"))).toBe(false);
		expect(isRetryableNetworkError("oops")).toBe(false);
	});
});

describe("httpErrorMessage", () => {
	it("formats prefix, status, and truncated body detail", async () => {
		const long = "x".repeat(600);
		const message = await httpErrorMessage("OpenAI Responses", httpResponse(503, long));
		expect(message).toBe(`OpenAI Responses HTTP 503 S503: ${"x".repeat(500)}`);
	});

	it("tolerates a body read failure", async () => {
		const response = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.error(new Error("read boom"));
				},
			}),
			{ status: 502, statusText: "Bad Gateway" },
		);
		const message = await httpErrorMessage("Anthropic Messages", response);
		expect(message).toBe("Anthropic Messages HTTP 502 Bad Gateway");
	});
});

describe("fetchWithRetry", () => {
	const INIT: RequestInit = { method: "POST" };

	it("returns 200 after two retryable 429s and reports both retries", async () => {
		const delays: number[] = [];
		const events: RetryEvent[] = [];
		const { fetch } = queueFetch(httpResponse(429), httpResponse(429), httpResponse(200, "ok"));

		const response = await fetchWithRetry({
			fetch,
			url: "https://x.test/v1/responses",
			init: INIT,
			policy: POLICY,
			headersMs: 1_000,
			sleep: instantSleep(delays),
			random: () => 0.5,
			onRetry: (e) => events.push(e),
		});

		expect(response.ok).toBe(true);
		expect(events).toEqual([
			{ attempt: 1, maxAttempts: 3, delayMs: 100, reason: "HTTP 429" },
			{ attempt: 2, maxAttempts: 3, delayMs: 200, reason: "HTTP 429" },
		]);
		expect(delays).toEqual([100, 200]);
	});

	it("honours Retry-After (seconds) capped at maxDelayMs", async () => {
		const delays: number[] = [];
		const retryAfter = new Response("", {
			status: 429,
			statusText: "Too Many Requests",
			headers: { "retry-after": "2" },
		});
		const capped = new Response("", {
			status: 503,
			headers: { "retry-after": "60" },
		});
		const { fetch } = queueFetch(retryAfter, capped, httpResponse(200));

		await fetchWithRetry({
			fetch,
			url: "https://x.test",
			init: INIT,
			policy: { ...POLICY, maxAttempts: 3, maxDelayMs: 5_000 },
			headersMs: 1_000,
			sleep: instantSleep(delays),
		});

		expect(delays).toEqual([2_000, 5_000]);
	});

	it("throws `<prefix> HTTP <status> … after N attempts` when retries are exhausted", async () => {
		const { fetch } = queueFetch(httpResponse(500, "e1"), httpResponse(500, "e2"), httpResponse(500, "e3"));

		await expect(
			fetchWithRetry({
				fetch,
				url: "https://x.test",
				init: INIT,
				policy: POLICY,
				headersMs: 1_000,
				sleep: instantSleep([]),
				httpErrorPrefix: "OpenAI Responses",
			}),
		).rejects.toThrow(/^OpenAI Responses HTTP 500 .*after 3 attempts$/u);
	});

	it("throws immediately on non-retryable status without sleeping", async () => {
		const delays: number[] = [];
		const events: RetryEvent[] = [];
		const queued = queueFetch(httpResponse(401, "bad key"));

		await expect(
			fetchWithRetry({
				fetch: queued.fetch,
				url: "https://x.test",
				init: INIT,
				policy: POLICY,
				headersMs: 1_000,
				sleep: instantSleep(delays),
				onRetry: (e) => events.push(e),
			}),
		).rejects.toThrow(/HTTP 401/u);

		expect(queued.calls).toBe(1);
		expect(delays).toEqual([]);
		expect(events).toEqual([]);
	});

	it("retries a TypeError network failure then succeeds", async () => {
		const { fetch } = queueFetch(() => Promise.reject(new TypeError("fetch failed")), httpResponse(200));
		const events: RetryEvent[] = [];

		const response = await fetchWithRetry({
			fetch,
			url: "https://x.test",
			init: INIT,
			policy: POLICY,
			headersMs: 1_000,
			sleep: instantSleep([]),
			random: () => 0.5,
			onRetry: (e) => events.push(e),
		});

		expect(response.ok).toBe(true);
		expect(events[0]).toMatchObject({ attempt: 1, reason: "network: fetch failed" });
	});

	it("retries a headers timeout", async () => {
		vi.useRealTimers();
		let calls = 0;
		const fetchFn: typeof globalThis.fetch = () => {
			calls += 1;
			return calls === 1 ? new Promise<Response>(() => {}) : Promise.resolve(httpResponse(200));
		};
		const events: RetryEvent[] = [];

		const response = await fetchWithRetry({
			fetch: fetchFn,
			url: "https://x.test",
			init: INIT,
			policy: POLICY,
			headersMs: 5,
			sleep: instantSleep([]),
			onRetry: (e) => events.push(e),
		});

		expect(response.ok).toBe(true);
		expect(calls).toBe(2);
		expect(events[0]).toMatchObject({ attempt: 1, reason: "headers timeout" });
	});

	it("throws StreamTimeoutError when every attempt hits the headers timeout", async () => {
		vi.useRealTimers();
		const fetchFn: typeof globalThis.fetch = () => new Promise<Response>(() => {});

		const failure = await fetchWithRetry({
			fetch: fetchFn,
			url: "https://x.test",
			init: INIT,
			policy: { ...POLICY, maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
			headersMs: 5,
			sleep: instantSleep([]),
		}).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(StreamTimeoutError);
		expect((failure as StreamTimeoutError).phase).toBe("headers");
	});

	it("rejects with AbortError when the caller aborts during backoff sleep", async () => {
		const ac = new AbortController();
		const queued = queueFetch(httpResponse(429), httpResponse(200));
		const sleep: Sleep = (_ms, signal) =>
			new Promise((_resolve, reject) => {
				signal?.addEventListener(
					"abort",
					() => reject(new DOMException("The operation was aborted.", "AbortError")),
					{ once: true },
				);
				ac.abort();
			});

		await expect(
			fetchWithRetry({
				fetch: queued.fetch,
				url: "https://x.test",
				init: INIT,
				policy: POLICY,
				headersMs: 1_000,
				signal: ac.signal,
				sleep,
			}),
		).rejects.toMatchObject({ name: "AbortError" });

		expect(queued.calls).toBe(1);
	});

	it("makes a single attempt when policy is false", async () => {
		const queued = queueFetch(httpResponse(429), httpResponse(200));

		await expect(
			fetchWithRetry({
				fetch: queued.fetch,
				url: "https://x.test",
				init: INIT,
				policy: false,
				headersMs: 1_000,
				sleep: instantSleep([]),
			}),
		).rejects.toThrow(/HTTP 429(?!.*after)/u);

		expect(queued.calls).toBe(1);
	});

	it("rejects pre-aborted callers without fetching", async () => {
		const ac = new AbortController();
		ac.abort();
		const queued = queueFetch(httpResponse(200));

		await expect(
			fetchWithRetry({
				fetch: queued.fetch,
				url: "https://x.test",
				init: INIT,
				policy: POLICY,
				headersMs: 1_000,
				signal: ac.signal,
			}),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(queued.calls).toBe(0);
	});
});
