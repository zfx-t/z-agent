import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildCompletionsBody,
	convertCompletionsMessages,
	convertCompletionsTools,
	createOpenAICompletionsModel,
	streamOpenAICompletions,
} from "../src/openai-completions.ts";
import type { AssistantMessageEvent, Context, Model } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const e of stream) {
		events.push(e);
	}
	return events;
}

function sseFromChunks(chunks: unknown[]): string {
	return `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
}

function mockFetchOk(sseBody: string, inspect?: (req: Request) => void): typeof fetch {
	return async (input, init) => {
		const req = new Request(input, init);
		inspect?.(req);
		return new Response(sseBody, {
			status: 200,
			headers: { "Content-Type": "text/event-stream" },
		});
	};
}

const model: Model = createOpenAICompletionsModel({
	id: "gpt-test",
	baseUrl: "https://example.test/v1",
});

const emptyContext: Context = { messages: [] };

function usageChunk(): unknown {
	return {
		choices: [],
		usage: {
			prompt_tokens: 10,
			completion_tokens: 4,
			total_tokens: 14,
			prompt_tokens_details: { cached_tokens: 2 },
			completion_tokens_details: { reasoning_tokens: 1 },
		},
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

describe("convertCompletionsMessages / tools", () => {
	it("maps system, user text, assistant text+toolCall, toolResult", () => {
		const messages = convertCompletionsMessages({
			systemPrompt: "You are helpful.",
			messages: [
				{ role: "user", content: "hi", timestamp: 1 },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "calling" },
						{ type: "toolCall", id: "call_1|fc_9", name: "echo", arguments: { t: 1 } },
					],
					api: "openai-completions",
					provider: "openai",
					model: "gpt-test",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call_1|fc_9",
					toolName: "echo",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: 3,
				},
			],
		});

		expect(messages[0]).toEqual({ role: "system", content: "You are helpful." });
		expect(messages[1]).toEqual({ role: "user", content: "hi" });
		expect(messages[2]).toEqual({
			role: "assistant",
			content: "calling",
			tool_calls: [{ id: "call_1", type: "function", function: { name: "echo", arguments: '{"t":1}' } }],
		});
		expect(messages[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: "ok" });
	});

	it("does not replay thinking blocks", () => {
		const messages = convertCompletionsMessages({
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "plan", thinkingSignature: "sig" },
						{ type: "text", text: "ok" },
					],
					api: "openai-completions",
					provider: "openai",
					model: "m",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 1,
				},
			],
		});
		expect(messages).toEqual([{ role: "assistant", content: "ok" }]);
	});

	it("maps images to image_url data URLs and prefixes error tool results", () => {
		const messages = convertCompletionsMessages({
			messages: [
				{
					role: "user",
					content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "call_2",
					toolName: "bash",
					content: [{ type: "text", text: "boom" }],
					isError: true,
					timestamp: 2,
				},
			],
		});
		expect(messages[0]).toEqual({
			role: "user",
			content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
		});
		expect(messages[1]).toEqual({ role: "tool", tool_call_id: "call_2", content: "Error: boom" });
	});

	it("convertCompletionsTools wraps function shape", () => {
		expect(convertCompletionsTools([{ name: "echo", description: "Echo", parameters: { type: "object" } }])).toEqual([
			{
				type: "function",
				function: { name: "echo", description: "Echo", parameters: { type: "object" } },
			},
		]);
	});

	it("buildCompletionsBody sets stream_options, max_tokens, reasoning_effort", () => {
		const body = buildCompletionsBody(model, { messages: [] }, { maxTokens: 64, reasoning: "high" });
		expect(body.stream).toBe(true);
		expect(body.stream_options).toEqual({ include_usage: true });
		expect(body.max_tokens).toBe(64);
		expect(body.reasoning_effort).toBe("high");
	});

	it("buildCompletionsBody rejects samplingParams clobbering contract fields", () => {
		const body = buildCompletionsBody(
			model,
			{ messages: [{ role: "user", content: "x", timestamp: 1 }] },
			{ samplingParams: { stream: false, model: "hijacked", messages: [], top_p: 0.5 } },
		);
		expect(body.stream).toBe(true);
		expect(body.model).toBe("gpt-test");
		expect(body.messages).toEqual([{ role: "user", content: "x" }]);
		expect(body.top_p).toBe(0.5);
	});
});

// ---------------------------------------------------------------------------
// Stream integration (mocked fetch)
// ---------------------------------------------------------------------------

describe("streamOpenAICompletions", () => {
	it("streams text deltas and done with usage", async () => {
		const sse = sseFromChunks([
			{ choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] },
			{ choices: [{ index: 0, delta: { content: "lo" } }] },
			{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
			usageChunk(),
		]);
		const stream = streamOpenAICompletions(model, emptyContext, { apiKey: "sk" }, { fetch: mockFetchOk(sse) });
		const events = await collect(stream);
		const final = await stream.result();

		expect(events[0]?.type).toBe("start");
		const types = events.map((e) => e.type);
		expect(types).toEqual(["start", "text_start", "text_delta", "text_delta", "text_end", "done"]);
		expect(final.stopReason).toBe("stop");
		expect(final.content).toEqual([{ type: "text", text: "Hello" }]);
		expect(final.usage.input).toBe(8); // 10 - 2 cached
		expect(final.usage.cacheRead).toBe(2);
		expect(final.usage.output).toBe(4);
		expect(final.usage.reasoning).toBe(1);
	});

	it("aggregates multiple tool_calls by index across chunks", async () => {
		const sse = sseFromChunks([
			{
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{ index: 0, id: "call_a", function: { name: "read", arguments: '{"pa' } },
								{ index: 1, id: "call_b", function: { name: "ls", arguments: '{"di' } },
							],
						},
					},
				],
			},
			{
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{ index: 1, function: { arguments: 'r":"."}' } },
								{ index: 0, function: { arguments: 'th":"x"}' } },
							],
						},
					},
				],
			},
			{ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
		]);
		const stream = streamOpenAICompletions(model, emptyContext, { apiKey: "sk" }, { fetch: mockFetchOk(sse) });
		const events = await collect(stream);
		const final = await stream.result();

		expect(final.stopReason).toBe("toolUse");
		expect(final.content).toHaveLength(2);
		expect(final.content[0]).toMatchObject({
			type: "toolCall",
			id: "call_a",
			name: "read",
			arguments: { path: "x" },
		});
		expect(final.content[1]).toMatchObject({ type: "toolCall", id: "call_b", name: "ls", arguments: { dir: "." } });

		// toolcall_end emitted per call, arguments only final at end
		const ends = events.filter((e) => e.type === "toolcall_end");
		expect(ends).toHaveLength(2);
		expect(events.at(-1)?.type).toBe("done");
	});

	it("finish_reason length maps to stopReason length", async () => {
		const sse = sseFromChunks([
			{ choices: [{ index: 0, delta: { content: "trunc" } }] },
			{ choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
		]);
		const final = await streamOpenAICompletions(
			model,
			emptyContext,
			{ apiKey: "sk" },
			{ fetch: mockFetchOk(sse) },
		).result();
		expect(final.stopReason).toBe("length");
	});

	it("maps reasoning_content to a thinking block", async () => {
		const sse = sseFromChunks([
			{ choices: [{ index: 0, delta: { reasoning_content: "hmm" } }] },
			{ choices: [{ index: 0, delta: { reasoning_content: " yes" } }] },
			{ choices: [{ index: 0, delta: { content: "answer" } }] },
			{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
		]);
		const stream = streamOpenAICompletions(model, emptyContext, { apiKey: "sk" }, { fetch: mockFetchOk(sse) });
		const events = await collect(stream);
		const final = await stream.result();
		const types = events.map((e) => e.type);
		expect(types).toContain("thinking_start");
		expect(types).toContain("thinking_delta");
		expect(types).toContain("thinking_end");
		expect(final.content[0]).toEqual({ type: "thinking", thinking: "hmm yes" });
		expect(final.content[1]).toMatchObject({ type: "text", text: "answer" });
	});

	it("POSTs /chat/completions with Bearer auth", async () => {
		let captured: Request | undefined;
		const sse = sseFromChunks([{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }]);
		const stream = streamOpenAICompletions(
			model,
			{ systemPrompt: "sys", messages: [{ role: "user", content: "u", timestamp: 1 }] },
			{ apiKey: "sk-secret", temperature: 0.3 },
			{
				fetch: mockFetchOk(sse, (req) => {
					captured = req;
				}),
			},
		);
		await collect(stream);

		expect(captured?.url).toBe("https://example.test/v1/chat/completions");
		expect(captured?.headers.get("Authorization")).toBe("Bearer sk-secret");
		const body = JSON.parse(await captured!.clone().text()) as Record<string, unknown>;
		expect(body.model).toBe("gpt-test");
		expect(body.stream).toBe(true);
		expect(body.temperature).toBe(0.3);
		expect((body.messages as unknown[])[0]).toEqual({ role: "system", content: "sys" });
	});

	it("encodes HTTP errors without throwing", async () => {
		const fetchMock: typeof fetch = async () =>
			new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401, statusText: "Unauthorized" });
		const stream = streamOpenAICompletions(model, emptyContext, { apiKey: "bad" }, { fetch: fetchMock });
		const events = await collect(stream);
		const final = await stream.result();
		expect(events.at(-1)?.type).toBe("error");
		expect(final.stopReason).toBe("error");
		expect(final.errorMessage).toMatch(/401/);
		expect(final.errorMessage?.length).toBeLessThanOrEqual(600);
	});

	it("encodes missing API key naming OPENAI_API_KEY", async () => {
		const stream = streamOpenAICompletions(model, emptyContext, {}, { fetch: mockFetchOk("data: [DONE]\n\n") });
		const final = await stream.result();
		expect(final.stopReason).toBe("error");
		expect(final.errorMessage).toMatch(/OPENAI_API_KEY/);
	});

	it("errors when stream ends without finish_reason", async () => {
		const sse = sseFromChunks([{ choices: [{ index: 0, delta: { content: "hi" } }] }]);
		const stream = streamOpenAICompletions(model, emptyContext, { apiKey: "sk" }, { fetch: mockFetchOk(sse) });
		const final = await stream.result();
		expect(final.stopReason).toBe("error");
		expect(final.errorMessage).toMatch(/finish_reason/);
	});

	it("encodes streamed error objects", async () => {
		const sse = sseFromChunks([{ error: { message: "rate limited" } }]);
		const stream = streamOpenAICompletions(model, emptyContext, { apiKey: "sk" }, { fetch: mockFetchOk(sse) });
		const final = await stream.result();
		expect(final.stopReason).toBe("error");
		expect(final.errorMessage).toMatch(/rate limited/);
	});

	it("encodes invalid tool arguments JSON as error", async () => {
		const sse = sseFromChunks([
			{
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [{ index: 0, id: "call_bad", function: { name: "x", arguments: "not-json{" } }],
						},
					},
				],
			},
			{ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
		]);
		const stream = streamOpenAICompletions(model, emptyContext, { apiKey: "sk" }, { fetch: mockFetchOk(sse) });
		const events = await collect(stream);
		const final = await stream.result();
		expect(events.some((e) => e.type === "toolcall_end")).toBe(true);
		expect(final.stopReason).toBe("error");
		expect(final.errorMessage).toMatch(/JSON/);
	});

	it("keeps partial arguments empty until toolcall_end", async () => {
		const sse = sseFromChunks([
			{
				choices: [
					{
						index: 0,
						delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "x", arguments: '{"a":' } }] },
					},
				],
			},
			{
				choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] } }],
			},
			{ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
		]);
		const stream = streamOpenAICompletions(model, emptyContext, { apiKey: "sk" }, { fetch: mockFetchOk(sse) });
		for await (const e of stream) {
			if (e.type === "toolcall_delta") {
				const block = e.partial.content[e.contentIndex];
				expect(block).toMatchObject({ type: "toolCall", arguments: {} });
			}
		}
		const final = await stream.result();
		expect(final.content[0]).toMatchObject({ arguments: { a: 1 } });
	});

	it("aborts mid-stream and retains partial content", async () => {
		const ac = new AbortController();
		const encoder = new TextEncoder();
		const chunks = [
			`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Hel" } }] })}\n\n`,
			`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "lo" } }] })}\n\n`,
			`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
			"data: [DONE]\n\n",
		];
		let i = 0;
		const fetchMock: typeof fetch = async (_input, init) => {
			const signal = init?.signal;
			const body = new ReadableStream<Uint8Array>({
				async pull(controller) {
					if (signal?.aborted) {
						controller.error(new DOMException("The operation was aborted.", "AbortError"));
						return;
					}
					if (i >= chunks.length) {
						controller.close();
						return;
					}
					controller.enqueue(encoder.encode(chunks[i]));
					i += 1;
					await new Promise<void>((r) => queueMicrotask(r));
				},
			});
			return new Response(body, { status: 200 });
		};

		const stream = streamOpenAICompletions(
			model,
			emptyContext,
			{ apiKey: "sk", signal: ac.signal },
			{ fetch: fetchMock },
		);
		let aborted = false;
		for await (const e of stream) {
			if (e.type === "text_delta" && !aborted) {
				aborted = true;
				ac.abort();
			}
		}
		const final = await stream.result();
		expect(final.stopReason).toBe("aborted");
		// The abort lands after the first delta; the second chunk may or may not
		// have been consumed already — assert a non-empty prefix, not exact text.
		expect(final.content[0]).toMatchObject({ type: "text" });
		if (final.content[0]?.type === "text") {
			expect("Hello".startsWith(final.content[0].text)).toBe(true);
			expect(final.content[0].text.length).toBeGreaterThan(0);
		}
	});
});
