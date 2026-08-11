import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildResponsesBody,
	convertResponsesMessages,
	convertResponsesTools,
	createOpenAIResponsesModel,
	createOpenAIResponsesStream,
	parseResponsesSse,
	streamOpenAIResponses,
} from "../src/openai-responses.ts";
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

function sseFromEvents(events: unknown[]): string {
	return `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`;
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

function textCompletedSse(text: string, responseId = "resp_1"): string {
	return sseFromEvents([
		{ type: "response.created", response: { id: responseId, status: "in_progress" } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: "msg_1", status: "in_progress", content: [] },
		},
		{ type: "response.output_text.delta", output_index: 0, delta: text },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "message",
				id: "msg_1",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: responseId,
				status: "completed",
				usage: {
					input_tokens: 10,
					output_tokens: 3,
					total_tokens: 13,
					input_tokens_details: { cached_tokens: 2 },
				},
			},
		},
	]);
}

function toolCallSse(argsJson: string, responseId = "resp_tool"): string {
	const callId = "call_abc";
	const itemId = "fc_1";
	// Split args for delta testing
	const mid = Math.max(1, Math.floor(argsJson.length / 2));
	const d1 = argsJson.slice(0, mid);
	const d2 = argsJson.slice(mid);
	return sseFromEvents([
		{ type: "response.created", response: { id: responseId, status: "in_progress" } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: {
				type: "function_call",
				id: itemId,
				call_id: callId,
				name: "echo",
				arguments: "",
			},
		},
		{ type: "response.function_call_arguments.delta", output_index: 0, delta: d1 },
		{ type: "response.function_call_arguments.delta", output_index: 0, delta: d2 },
		{
			type: "response.function_call_arguments.done",
			output_index: 0,
			arguments: argsJson,
		},
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "function_call",
				id: itemId,
				call_id: callId,
				name: "echo",
				arguments: argsJson,
			},
		},
		{
			type: "response.completed",
			response: {
				id: responseId,
				status: "completed",
				usage: { input_tokens: 5, output_tokens: 8, total_tokens: 13 },
			},
		},
	]);
}

const model: Model = createOpenAIResponsesModel({
	id: "gpt-test",
	baseUrl: "https://example.test/v1",
});

const emptyContext: Context = { messages: [] };

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

describe("convertResponsesMessages / tools", () => {
	it("maps system, user text, assistant text, toolCall, toolResult", () => {
		const input = convertResponsesMessages({
			systemPrompt: "You are helpful.",
			messages: [
				{ role: "user", content: "hi", timestamp: 1 },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "calling", textSignature: "msg_prev" },
						{ type: "toolCall", id: "call_1|fc_1", name: "echo", arguments: { t: 1 } },
					],
					api: "openai-responses",
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
					toolCallId: "call_1|fc_1",
					toolName: "echo",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: 3,
				},
			],
		});

		expect(input[0]).toEqual({ role: "system", content: "You are helpful." });
		expect(input[1]).toEqual({
			role: "user",
			content: [{ type: "input_text", text: "hi" }],
		});
		expect(input[2]).toMatchObject({
			type: "message",
			role: "assistant",
			id: "msg_prev",
			content: [{ type: "output_text", text: "calling" }],
		});
		expect(input[3]).toEqual({
			type: "function_call",
			id: "fc_1",
			call_id: "call_1",
			name: "echo",
			arguments: '{"t":1}',
		});
		expect(input[4]).toEqual({
			type: "function_call_output",
			call_id: "call_1",
			output: "ok",
		});
	});

	it("convertResponsesTools maps function tools", () => {
		expect(
			convertResponsesTools([
				{
					name: "echo",
					description: "Echo",
					parameters: { type: "object", properties: { t: { type: "string" } } },
				},
			]),
		).toEqual([
			{
				type: "function",
				name: "echo",
				description: "Echo",
				parameters: { type: "object", properties: { t: { type: "string" } } },
				strict: false,
			},
		]);
	});

	it("buildResponsesBody clamps max_output_tokens and merges samplingParams", () => {
		const body = buildResponsesBody(
			model,
			{ messages: [], tools: [{ name: "a", description: "d", parameters: {} }] },
			{
				maxTokens: 4,
				temperature: 0.2,
				samplingParams: { top_p: 0.9 },
			},
		);
		expect(body.stream).toBe(true);
		expect(body.store).toBe(false);
		expect(body.max_output_tokens).toBe(16);
		expect(body.temperature).toBe(0.2);
		expect(body.top_p).toBe(0.9);
		expect(body.tools?.[0]?.name).toBe("a");
	});
});

// ---------------------------------------------------------------------------
// SSE parser
// ---------------------------------------------------------------------------

describe("parseResponsesSse", () => {
	it("parses data lines and ignores [DONE]", async () => {
		const sse = 'data: {"type":"response.created","response":{"id":"r1"}}\n\ndata: [DONE]\n\n';
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(sse));
				controller.close();
			},
		});
		const events = [];
		for await (const e of parseResponsesSse(stream)) {
			events.push(e);
		}
		expect(events).toHaveLength(1);
		expect(events[0]?.type).toBe("response.created");
	});
});

// ---------------------------------------------------------------------------
// Stream integration (mocked fetch)
// ---------------------------------------------------------------------------

describe("streamOpenAIResponses", () => {
	it("streams text start/delta/end and done", async () => {
		const fetchMock = mockFetchOk(textCompletedSse("Hello"));
		const stream = streamOpenAIResponses(model, emptyContext, { apiKey: "sk-test" }, { fetch: fetchMock });
		const events = await collect(stream);
		const final = await stream.result();

		expect(events[0]?.type).toBe("start");
		expect(events.some((e) => e.type === "text_start")).toBe(true);
		expect(events.some((e) => e.type === "text_delta" && e.delta === "Hello")).toBe(true);
		expect(events.some((e) => e.type === "text_end" && e.content === "Hello")).toBe(true);
		expect(events.at(-1)?.type).toBe("done");
		expect(final.stopReason).toBe("stop");
		expect(final.content).toEqual([{ type: "text", text: "Hello", textSignature: "msg_1" }]);
		expect(final.responseId).toBe("resp_1");
		expect(final.usage.input).toBe(8); // 10 - 2 cached
		expect(final.usage.cacheRead).toBe(2);
		expect(final.usage.output).toBe(3);
	});

	it("streams tool calls and sets stopReason toolUse", async () => {
		const args = JSON.stringify({ text: "hi" });
		const stream = streamOpenAIResponses(
			model,
			{
				messages: [{ role: "user", content: "call", timestamp: 1 }],
				tools: [{ name: "echo", description: "Echo", parameters: { type: "object" } }],
			},
			{ apiKey: "sk-test" },
			{ fetch: mockFetchOk(toolCallSse(args)) },
		);
		const events = await collect(stream);
		const final = await stream.result();

		const types = events.map((e) => e.type);
		expect(types).toContain("toolcall_start");
		expect(types).toContain("toolcall_delta");
		expect(types).toContain("toolcall_end");
		expect(types.at(-1)).toBe("done");
		expect(final.stopReason).toBe("toolUse");
		expect(final.content[0]).toMatchObject({
			type: "toolCall",
			id: "call_abc|fc_1",
			name: "echo",
			arguments: { text: "hi" },
		});

		// toolcall_delta carries JSON fragments; final args only guaranteed on toolcall_end
		const deltas = events.filter((e) => e.type === "toolcall_delta");
		expect(deltas.length).toBeGreaterThan(0);
		expect(deltas.map((e) => (e.type === "toolcall_delta" ? e.delta : "")).join("")).toBe(args);
	});

	it("POSTs /responses with auth, stream body, and tools", async () => {
		let captured: Request | undefined;
		const fetchMock = mockFetchOk(textCompletedSse("ok"), (req) => {
			captured = req;
		});

		const stream = streamOpenAIResponses(
			model,
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "u", timestamp: 1 }],
				tools: [{ name: "echo", description: "d", parameters: { type: "object" } }],
			},
			{ apiKey: "sk-secret", temperature: 0.5, maxTokens: 100 },
			{ fetch: fetchMock },
		);
		await collect(stream);

		expect(captured).toBeDefined();
		expect(captured?.method).toBe("POST");
		expect(captured?.url).toBe("https://example.test/v1/responses");
		expect(captured?.headers.get("Authorization")).toBe("Bearer sk-secret");
		expect(captured?.headers.get("Content-Type")).toBe("application/json");
		const body = JSON.parse(await captured!.clone().text()) as Record<string, unknown>;
		expect(body.model).toBe("gpt-test");
		expect(body.stream).toBe(true);
		expect(body.store).toBe(false);
		expect(body.temperature).toBe(0.5);
		expect(body.max_output_tokens).toBe(100);
		expect(Array.isArray(body.input)).toBe(true);
		expect(Array.isArray(body.tools)).toBe(true);
	});

	it("encodes HTTP errors without throwing from StreamFn", async () => {
		const fetchMock: typeof fetch = async () =>
			new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401, statusText: "Unauthorized" });

		const stream = streamOpenAIResponses(model, emptyContext, { apiKey: "bad" }, { fetch: fetchMock });
		const events = await collect(stream);
		const final = await stream.result();

		expect(events.at(-1)?.type).toBe("error");
		expect(final.stopReason).toBe("error");
		expect(final.errorMessage).toMatch(/401/);
	});

	it("encodes missing API key as error message", async () => {
		const stream = streamOpenAIResponses(model, emptyContext, {}, { fetch: mockFetchOk(textCompletedSse("x")) });
		const final = await stream.result();
		expect(final.stopReason).toBe("error");
		expect(final.errorMessage).toMatch(/API key/i);
	});

	it("honors AbortSignal before and during stream", async () => {
		const ac = new AbortController();
		ac.abort();
		const stream = streamOpenAIResponses(
			model,
			emptyContext,
			{ apiKey: "sk", signal: ac.signal },
			{ fetch: mockFetchOk(textCompletedSse("nope")) },
		);
		const final = await stream.result();
		expect(final.stopReason).toBe("aborted");
		expect(final.errorMessage).toMatch(/abort/i);
	});

	it("maps incomplete max_output_tokens to length", async () => {
		const sse = sseFromEvents([
			{ type: "response.created", response: { id: "r", status: "in_progress" } },
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "message", id: "m", content: [] },
			},
			{ type: "response.output_text.delta", output_index: 0, delta: "cut" },
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "message",
					id: "m",
					content: [{ type: "output_text", text: "cut" }],
				},
			},
			{
				type: "response.incomplete",
				response: {
					id: "r",
					status: "incomplete",
					incomplete_details: { reason: "max_output_tokens" },
					usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
				},
			},
		]);
		const stream = streamOpenAIResponses(model, emptyContext, { apiKey: "sk" }, { fetch: mockFetchOk(sse) });
		const final = await stream.result();
		expect(final.stopReason).toBe("length");
		expect(final.content[0]).toMatchObject({ type: "text", text: "cut" });
	});

	it("createOpenAIResponsesStream factory wires config.fetch and apiKey", async () => {
		const streamFn = createOpenAIResponsesStream({
			apiKey: "from-config",
			baseUrl: "https://cfg.test/v1",
			fetch: mockFetchOk(textCompletedSse("via-factory")),
		});
		const m = createOpenAIResponsesModel({ id: "m1", baseUrl: "" });
		// empty baseUrl → config baseUrl
		const stream = await streamFn(m, emptyContext);
		const final = await stream.result();
		expect(final.stopReason).toBe("stop");
		expect(final.content).toEqual([expect.objectContaining({ type: "text", text: "via-factory" })]);
	});

	it("uses model.baseUrl over config when set", async () => {
		let url = "";
		const streamFn = createOpenAIResponsesStream({
			apiKey: "k",
			baseUrl: "https://config.invalid/v1",
			fetch: mockFetchOk(textCompletedSse("u"), (req) => {
				url = req.url;
			}),
		});
		await collect(await streamFn(model, emptyContext));
		expect(url).toBe("https://example.test/v1/responses");
	});
});
