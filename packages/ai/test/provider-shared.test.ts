import { describe, expect, it } from "vitest";
import { httpErrorMessage, resolveHttpConfig } from "../src/provider-shared.ts";
import { DEFAULT_RETRY_POLICY } from "../src/retry.ts";
import { DEFAULT_STREAM_TIMEOUTS } from "../src/timeouts.ts";

describe("resolveHttpConfig", () => {
	it("returns defaults for an empty config", () => {
		const resolved = resolveHttpConfig();
		expect(typeof resolved.fetch).toBe("function");
		expect(resolved.retry).toEqual(DEFAULT_RETRY_POLICY);
		expect(resolved.timeouts).toEqual(DEFAULT_STREAM_TIMEOUTS);
		expect(resolved.onRetry).toBeUndefined();
	});

	it("keeps retry: false disabled", () => {
		expect(resolveHttpConfig({ retry: false }).retry).toBe(false);
	});

	it("merges partial retry and timeouts over defaults", () => {
		const resolved = resolveHttpConfig({
			retry: { maxAttempts: 5 },
			timeouts: { idleMs: 5 },
		});
		expect(resolved.retry).toMatchObject({
			maxAttempts: 5,
			baseDelayMs: DEFAULT_RETRY_POLICY.baseDelayMs,
			maxDelayMs: DEFAULT_RETRY_POLICY.maxDelayMs,
		});
		expect(resolved.timeouts).toEqual({ headersMs: 60_000, idleMs: 5 });
	});

	it("passes fetch and onRetry through", () => {
		const fetchFn: typeof fetch = async () => new Response("");
		const onRetry = () => {};
		const resolved = resolveHttpConfig({ fetch: fetchFn, onRetry });
		expect(resolved.fetch).toBe(fetchFn);
		expect(resolved.onRetry).toBe(onRetry);
	});
});

describe("httpErrorMessage", () => {
	it("builds `<prefix> HTTP <status> <statusText>: <detail>`", async () => {
		const response = new Response("nope", { status: 403, statusText: "Forbidden" });
		expect(await httpErrorMessage("OpenAI Completions", response)).toBe(
			"OpenAI Completions HTTP 403 Forbidden: nope",
		);
	});

	it("truncates the body detail to 500 chars", async () => {
		const response = new Response("e".repeat(700), { status: 500, statusText: "Internal" });
		const message = await httpErrorMessage("P", response);
		expect(message).toBe(`P HTTP 500 Internal: ${"e".repeat(500)}`);
	});

	it("omits detail when the body cannot be read", async () => {
		const response = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.error(new Error("boom"));
				},
			}),
			{ status: 500, statusText: "Internal" },
		);
		expect(await httpErrorMessage("P", response)).toBe("P HTTP 500 Internal");
	});
});
