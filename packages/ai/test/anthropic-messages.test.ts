import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildAnthropicBody,
	convertAnthropicMessages,
	convertAnthropicTools,
	createAnthropicMessagesModel,
	streamAnthropicMessages,
} from "../src/anthropic-messages.ts";
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

/** Anthropic SSE uses event: lines; our parser only needs data: lines. */
function sseFromEvents(events: Array<{ event: string; data: unknown }>): string {
	return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
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

const model: Model = createAnthropicMessagesModel({
	id: "claude-test",
	baseUrl: "https://anthropic.test",
});

const emptyContext: Context = { messages: [] };

function messageStart(): { event: string; data: unknown } {
	return {
		event: "message_start",
		data: {
			type: "message_start",
			message: {
				id: "msg_1",
				usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 },
			},
		},
	};
}

function messageStopSequence(stopReason: string): Array<{ event: string; data: unknown }> {
	return [
		{
			event: "message_delta",
			data: {
				type: "message_delta",
				delta: { stop_reason: stopReason },
				usage: { output_tokens: 7 },
			},
		},
		{ event: "message_stop", data: { type: "message_stop" } },
	];
}

function usage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Conversion (round-trip fidelity)
// ---------------------------------------------------------------------------

describe("convertAnthropicMessages / tools", () => {
	it("maps user/assistant/toolResult; thinking replays signature verbatim", () => {
		const messages = convertAnthropicMessages({
			systemPrompt: "ignored here",
			messages: [
				{ role: "user", content: "hi", timestamp: 1 },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "plan", thinkingSignature: "sig_abc" },
						{ type: "text", text: "calling" },
						{ type: "toolCall", id: "toolu_1", name: "echo", arguments: { t: 1 } },
					],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-test",
					usage: usage(),
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "toolu_1",
					toolName: "echo",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: 3,
				},
			],
		});

		expect(messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "hi" }] });
		expect(messages[1]).toEqual({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "plan", signature: "sig_abc" },
				{ type: "text", text: "calling" },
				{ type: "tool_use", id: "toolu_1", name: "echo", input: { t: 1 } },
			],
		});
		expect(messages[2]).toEqual({
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "ok" }] }],
		});
	});

	it("merges consecutive toolResults into one user message and carries is_error", () => {
		const messages = convertAnthropicMessages({
			messages: [
				{
					role: "toolResult",
					toolCallId: "t1",
					toolName: "a",
					content: [{ type: "text", text: "one" }],
					isError: false,
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "t2",
					toolName: "b",
					content: [{ type: "text", text: "bad" }],
					isError: true,
					timestamp: 2,
				},
			],
		});
		expect(messages).toHaveLength(1);
		expect(messages[0]?.role).toBe("user");
		expect(messages[0]?.content).toEqual([
			{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "one" }] },
			{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "bad" }], is_error: true },
		]);
	});

	it("drops unsigned thinking; replays redacted thinking as redacted_thinking", () => {
		const messages = convertAnthropicMessages({
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "no sig" },
						{ type: "thinking", thinking: "", thinkingSignature: "blob", redacted: true },
						{ type: "text", text: "ok" },
					],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "m",
					usage: usage(),
					stopReason: "stop",
					timestamp: 1,
				},
			],
		});
		expect(messages[0]?.content).toEqual([
			{ type: "redacted_thinking", data: "blob" },
			{ type: "text", text: "ok" },
		]);
	});

	it("maps user images to base64 sources", () => {
		const messages = convertAnthropicMessages({
			messages: [
				{
					role: "user",
					content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
					timestamp: 1,
				},
			],
		});
		expect(messages[0]?.content).toEqual([
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
		]);
	});

	it("convertAnthropicTools uses input_schema", () => {
		expect(convertAnthropicTools([{ name: "echo", description: "Echo", parameters: { type: "object" } }])).toEqual([
			{ name: "echo", description: "Echo", input_schema: { type: "object" } },
		]);
	});

	it("buildAnthropicBody: system top-level, max_tokens always, thinking budget clamped", () => {
		const body = buildAnthropicBody(
			model,
			{ systemPrompt: "sys", messages: [] },
			{ reasoning: "high", maxTokens: 4096 },
		);
		expect(body.system).toBe("sys");
		expect(body.max_tokens).toBe(4096);
		expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 4095 });
		expect(body.stream).toBe(true);

		const small = buildAnthropicBody(model, { messages: [] }, { reasoning: "medium", maxTokens: 500 });
		expect(small.thinking).toBeUndefined(); // budget would be < 1024
	});

	it("buildAnthropicBody defaults max_tokens from model then 4096", () => {
		const withModel = buildAnthropicBody({ ...model, maxTokens: 2048 }, { messages: [] });
		expect(withModel.max_tokens).toBe(2048);
		const fallback = buildAnthropicBody(model, { messages: [] });
		expect(fallback.max_tokens).toBe(4096);
	});
});

// ---------------------------------------------------------------------------
// Stream integration (mocked fetch)
// ---------------------------------------------------------------------------

describe("streamAnthropicMessages", () => {
	it("streams text blocks with correct event order and usage", async () => {
		const sse = sseFromEvents([
			messageStart(),
			{
				event: "content_block_start",
				data: { type: "content_block_start", index: 0, content_block: { type: "text" } },
			},
			{
				event: "content_block_delta",
				data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
			},
			{
				event: "content_block_delta",
				data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
			},
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			...messageStopSequence("end_turn"),
		]);
		const stream = streamAnthropicMessages(model, emptyContext, { apiKey: "sk" }, { fetch: mockFetchOk(sse) });
		const events = await collect(stream);
		const final = await stream.result();

		const types = events.map((e) => e.type);
		expect(types).toEqual(["start", "text_start", "text_delta", "text_delta", "text_end", "done"]);
		expect(final.stopReason).toBe("stop");
		expect(final.content).toEqual([{ type: "text", text: "Hello" }]);
		// message_start: input 10, cacheRead 4, cacheWrite 2 → input = 10-4-2 = 4
		expect(final.usage.input).toBe(4);
		expect(final.usage.cacheRead).toBe(4);
		expect(final.usage.cacheWrite).toBe(2);
		// message_delta output_tokens replaces message_start's 1
		expect(final.usage.output).toBe(7);
	});

	it("streams thinking with signature_delta into thinkingSignature", async () => {
		const sse = sseFromEvents([
			messageStart(),
			{
				event: "content_block_start",
				data: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
			},
			{
				event: "content_block_delta",
				data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "plan " } },
			},
			{
				event: "content_block_delta",
				data: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sigX" } },
			},
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			{
				event: "content_block_start",
				data: { type: "content_block_start", index: 1, content_block: { type: "text" } },
			},
			{
				event: "content_block_delta",
				data: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "done" } },
			},
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
			...messageStopSequence("end_turn"),
		]);
		const stream = streamAnthropicMessages(model, emptyContext, { apiKey: "sk" }, { fetch: mockFetchOk(sse) });
		const events = await collect(stream);
		const final = await stream.result();

		const types = events.map((e) => e.type);
		expect(types.indexOf("thinking_start")).toBeLessThan(types.indexOf("text_start"));
		expect(final.content[0]).toEqual({ type: "thinking", thinking: "plan ", thinkingSignature: "sigX" });
		expect(final.content[1]).toEqual({ type: "text", text: "done" });
	});

	it("streams tool_use via input_json_delta and maps stop_reason tool_use", async () => {
		const sse = sseFromEvents([
			messageStart(),
			{
				event: "content_block_start",
				data: {
					type: "content_block_start",
					index: 0,
					content_block: { type: "tool_use", id: "toolu_9", name: "read" },
				},
			},
			{
				event: "content_block_delta",
				data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"pa' } },
			},
			{
				event: "content_block_delta",
				data: {
					type: "content_block_delta",
					index: 0,
					delta: { type: "input_json_delta", partial_json: 'th":"x"}' },
				},
			},
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			...messageStopSequence("tool_use"),
		]);
		const stream = streamAnthropicMessages(model, emptyContext, { apiKey: "sk" }, { fetch: mockFetchOk(sse) });
		const events = await collect(stream);
		const final = await stream.result();

		const types = events.map((e) => e.type);
		expect(types).toEqual(["start", "toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_end", "done"]);
		expect(final.stopReason).toBe("toolUse");
		expect(final.content[0]).toMatchObject({
			type: "toolCall",
			id: "toolu_9",
			name: "read",
			arguments: { path: "x" },
		});
	});

	it("stop_reason matrix: max_tokens→length, refusal→error", async () => {
		for (const [wire, want] of [
			["max_tokens", "length"],
			["refusal", "error"],
		] as const) {
			const sse = sseFromEvents([messageStart(), ...messageStopSequence(wire)]);
			const final = await streamAnthropicMessages(
				model,
				emptyContext,
				{ apiKey: "sk" },
				{ fetch: mockFetchOk(sse) },
			).result();
			expect(final.stopReason).toBe(want);
		}
	});

	it("sends x-api-key + anthropic-version; anthropic-beta only when thinking", async () => {
		const requests: Request[] = [];
		const sse = sseFromEvents([messageStart(), ...messageStopSequence("end_turn")]);
		const inspect = (req: Request) => requests.push(req);

		await collect(
			streamAnthropicMessages(model, emptyContext, { apiKey: "sk-ant" }, { fetch: mockFetchOk(sse, inspect) }),
		);
		await collect(
			streamAnthropicMessages(
				model,
				emptyContext,
				{ apiKey: "sk-ant", reasoning: "low" },
				{ fetch: mockFetchOk(sse, inspect) },
			),
		);

		for (const req of requests) {
			expect(req.url).toBe("https://anthropic.test/v1/messages");
			expect(req.headers.get("x-api-key")).toBe("sk-ant");
			expect(req.headers.get("anthropic-version")).toBe("2023-06-01");
			expect(req.headers.get("Authorization")).toBeNull();
		}
		expect(requests[0]?.headers.get("anthropic-beta")).toBeNull();
		expect(requests[1]?.headers.get("anthropic-beta")).toBe("interleaved-thinking-2025-05-14");
		const body = JSON.parse(await requests[1]!.clone().text()) as { thinking?: { budget_tokens: number } };
		expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
	});

	it("encodes HTTP errors without throwing", async () => {
		const fetchMock: typeof fetch = async () =>
			new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 403, statusText: "Forbidden" });
		const final = await streamAnthropicMessages(
			model,
			emptyContext,
			{ apiKey: "bad" },
			{ fetch: fetchMock },
		).result();
		expect(final.stopReason).toBe("error");
		expect(final.errorMessage).toMatch(/403/);
	});

	it("encodes missing API key naming ANTHROPIC_API_KEY", async () => {
		const stream = streamAnthropicMessages(model, emptyContext, {}, { fetch: mockFetchOk("") });
		const final = await stream.result();
		expect(final.stopReason).toBe("error");
		expect(final.errorMessage).toMatch(/ANTHROPIC_API_KEY/);
	});

	it("encodes stream error events", async () => {
		const sse = sseFromEvents([
			messageStart(),
			{ event: "error", data: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } },
		]);
		const final = await streamAnthropicMessages(
			model,
			emptyContext,
			{ apiKey: "sk" },
			{ fetch: mockFetchOk(sse) },
		).result();
		expect(final.stopReason).toBe("error");
		expect(final.errorMessage).toMatch(/Overloaded/);
	});

	it("errors when stream ends without message_stop", async () => {
		const sse = sseFromEvents([messageStart()]);
		const final = await streamAnthropicMessages(
			model,
			emptyContext,
			{ apiKey: "sk" },
			{ fetch: mockFetchOk(sse) },
		).result();
		expect(final.stopReason).toBe("error");
		expect(final.errorMessage).toMatch(/message_stop/);
	});

	it("encodes invalid tool input JSON as error", async () => {
		const sse = sseFromEvents([
			messageStart(),
			{
				event: "content_block_start",
				data: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "x" } },
			},
			{
				event: "content_block_delta",
				data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "oops{" } },
			},
			{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
			...messageStopSequence("tool_use"),
		]);
		const stream = streamAnthropicMessages(model, emptyContext, { apiKey: "sk" }, { fetch: mockFetchOk(sse) });
		const events = await collect(stream);
		const final = await stream.result();
		expect(events.some((e) => e.type === "toolcall_end")).toBe(true);
		expect(final.stopReason).toBe("error");
		expect(final.errorMessage).toMatch(/JSON/);
	});
});
