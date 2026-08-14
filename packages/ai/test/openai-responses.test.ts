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

	it("prefixes toolResult output when isError is true", () => {
		const input = convertResponsesMessages({
			messages: [
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "echo",
					content: [{ type: "text", text: "boom" }],
					isError: true,
					timestamp: 1,
				},
			],
		});
		expect(input[0]).toEqual({
			type: "function_call_output",
			call_id: "call_1",
			output: "Error: boom",
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

	it("buildResponsesBody does not let samplingParams clobber stream/store/model/input", () => {
		const body = buildResponsesBody(
			model,
			{ messages: [{ role: "user", content: "x", timestamp: 1 }] },
			{
				samplingParams: {
					stream: false,
					store: true,
					model: "hijacked",
					input: [{ role: "user", content: "nope" }],
					top_p: 0.1,
				},
			},
		);
		expect(body.stream).toBe(true);
		expect(body.store).toBe(false);
		expect(body.model).toBe("gpt-test");
		expect(body.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "x" }] }]);
		expect(body.top_p).toBe(0.1);
	});

	it("buildResponsesBody sets reasoning.effort from options.reasoning", () => {
		const withEffort = buildResponsesBody(model, { messages: [] }, { reasoning: "low" });
		expect(withEffort.reasoning).toEqual({ effort: "low" });
		expect(withEffort.include).toEqual(["reasoning.encrypted_content"]);

		const without = buildResponsesBody(model, { messages: [] });
		expect(without.reasoning).toBeUndefined();
	});

	it("replays thinkingSignature as a reasoning input item", () => {
		const signature = JSON.stringify({
			type: "reasoning",
			id: "rs_1",
			encrypted_content: "enc",
			summary: [{ type: "summary_text", text: "plan" }],
		});
		const input = convertResponsesMessages({
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "plan", thinkingSignature: signature },
						{ type: "text", text: "ok" },
					],
					api: "openai-responses",
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
		expect(input.some((item) => typeof item === "object" && "type" in item && item.type === "reasoning")).toBe(true);
	});

	it("omits thinking blocks that have no thinkingSignature", () => {
		const input = convertResponsesMessages({
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "plan" },
						{ type: "text", text: "ok" },
					],
					api: "openai-responses",
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
		expect(input.some((item) => typeof item === "object" && "type" in item && item.type === "reasoning")).toBe(false);
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

	it("honors already-aborted AbortSignal", async () => {
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

	it("aborts mid-stream after text_delta and retains partial content", async () => {
		const ac = new AbortController();
		const encoder = new TextEncoder();
		const sseChunks = [
			`data: ${JSON.stringify({ type: "response.created", response: { id: "resp_mid", status: "in_progress" } })}\n\n`,
			`data: ${JSON.stringify({
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "message", id: "msg_mid", status: "in_progress", content: [] },
			})}\n\n`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", output_index: 0, delta: "Hel" })}\n\n`,
			// Remaining chunks should not be required after abort
			`data: ${JSON.stringify({ type: "response.output_text.delta", output_index: 0, delta: "lo world" })}\n\n`,
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "message",
					id: "msg_mid",
					content: [{ type: "output_text", text: "Hello world" }],
				},
			})}\n\n`,
			`data: ${JSON.stringify({
				type: "response.completed",
				response: { id: "resp_mid", status: "completed" },
			})}\n\n`,
		];

		let chunkIndex = 0;
		const fetchMock: typeof fetch = async (_input, init) => {
			const signal = init?.signal;
			const body = new ReadableStream<Uint8Array>({
				async pull(controller) {
					if (signal?.aborted) {
						controller.error(new DOMException("The operation was aborted.", "AbortError"));
						return;
					}
					if (chunkIndex >= sseChunks.length) {
						controller.close();
						return;
					}
					controller.enqueue(encoder.encode(sseChunks[chunkIndex]));
					chunkIndex += 1;
					// Allow the consumer to observe the delta and abort between chunks.
					await new Promise<void>((resolve) => queueMicrotask(resolve));
				},
			});
			return new Response(body, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		};

		const stream = streamOpenAIResponses(
			model,
			emptyContext,
			{ apiKey: "sk", signal: ac.signal },
			{ fetch: fetchMock },
		);

		const types: string[] = [];
		let lastPartialContent: unknown;
		let aborted = false;
		for await (const e of stream) {
			types.push(e.type);
			if ("partial" in e) {
				lastPartialContent = e.partial.content;
			}
			if (e.type === "text_delta" && !aborted) {
				aborted = true;
				ac.abort();
			}
		}
		const final = await stream.result();

		expect(types[0]).toBe("start");
		expect(types).toContain("text_delta");
		expect(types.at(-1)).toBe("error");
		expect(final.stopReason).toBe("aborted");
		expect(final.content.length).toBeGreaterThan(0);
		expect(final.content[0]).toMatchObject({ type: "text" });
		if (final.content[0]?.type === "text") {
			expect(final.content[0].text.length).toBeGreaterThan(0);
		}
		expect(lastPartialContent).toEqual(final.content);
	});

	it("encodes response.failed as error without throwing", async () => {
		const sse = sseFromEvents([
			{ type: "response.created", response: { id: "r_fail", status: "in_progress" } },
			{
				type: "response.failed",
				response: {
					id: "r_fail",
					status: "failed",
					error: { code: "server_error", message: "boom" },
				},
			},
		]);
		const stream = streamOpenAIResponses(model, emptyContext, { apiKey: "sk" }, { fetch: mockFetchOk(sse) });
		const events = await collect(stream);
		const final = await stream.result();
		expect(events.at(-1)?.type).toBe("error");
		expect(final.stopReason).toBe("error");
		expect(final.errorMessage).toMatch(/server_error|boom/);
	});

	it("encodes malformed SSE JSON as error without throwing", async () => {
		const sse = "data: {not-json\n\n";
		const stream = streamOpenAIResponses(model, emptyContext, { apiKey: "sk" }, { fetch: mockFetchOk(sse) });
		const events = await collect(stream);
		const final = await stream.result();
		expect(events.at(-1)?.type).toBe("error");
		expect(final.stopReason).toBe("error");
		expect(final.errorMessage).toBeTruthy();
	});

	it("encodes invalid tool arguments JSON as error stopReason", async () => {
		const sse = sseFromEvents([
			{ type: "response.created", response: { id: "r_bad", status: "in_progress" } },
			{
				type: "response.output_item.added",
				output_index: 0,
				item: {
					type: "function_call",
					id: "fc_bad",
					call_id: "call_bad",
					name: "echo",
					arguments: "",
				},
			},
			{ type: "response.function_call_arguments.delta", output_index: 0, delta: "not-json{" },
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "function_call",
					id: "fc_bad",
					call_id: "call_bad",
					name: "echo",
					arguments: "not-json{",
				},
			},
			{
				type: "response.completed",
				response: { id: "r_bad", status: "completed" },
			},
		]);
		const stream = streamOpenAIResponses(model, emptyContext, { apiKey: "sk" }, { fetch: mockFetchOk(sse) });
		const events = await collect(stream);
		const final = await stream.result();
		expect(events.some((e) => e.type === "toolcall_end")).toBe(true);
		expect(events.at(-1)?.type).toBe("error");
		expect(final.stopReason).toBe("error");
		expect(final.errorMessage).toMatch(/Invalid tool call arguments JSON/i);
		expect(final.content[0]).toMatchObject({ type: "toolCall", name: "echo", arguments: {} });
	});

	it("finalizes open text slots when provider omits output_item.done", async () => {
		const sse = sseFromEvents([
			{ type: "response.created", response: { id: "r_open", status: "in_progress" } },
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "message", id: "msg_open", content: [] },
			},
			{ type: "response.output_text.delta", output_index: 0, delta: "partial" },
			{
				type: "response.completed",
				response: { id: "r_open", status: "completed" },
			},
		]);
		const stream = streamOpenAIResponses(model, emptyContext, { apiKey: "sk" }, { fetch: mockFetchOk(sse) });
		const events = await collect(stream);
		const final = await stream.result();
		expect(events.some((e) => e.type === "text_end")).toBe(true);
		expect(final.stopReason).toBe("stop");
		expect(final.content[0]).toMatchObject({ type: "text", text: "partial" });
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

	it("parses reasoning SSE and stores thinkingSignature", async () => {
		const item = {
			type: "reasoning",
			id: "rs_1",
			encrypted_content: "enc",
			summary: [{ type: "summary_text", text: "think" }],
		};
		const sse = sseFromEvents([
			{ type: "response.created", response: { id: "resp_r", status: "in_progress" } },
			{ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1" } },
			{ type: "response.reasoning_summary_text.delta", output_index: 0, delta: "think" },
			{ type: "response.output_item.done", output_index: 0, item },
			{
				type: "response.output_item.added",
				output_index: 1,
				item: { type: "message", id: "msg_r", status: "in_progress", content: [] },
			},
			{ type: "response.output_text.delta", output_index: 1, delta: "hi" },
			{
				type: "response.output_item.done",
				output_index: 1,
				item: { type: "message", id: "msg_r", status: "completed", content: [{ type: "output_text", text: "hi" }] },
			},
			{ type: "response.completed", response: { id: "resp_r", status: "completed" } },
		]);
		const stream = streamOpenAIResponses(model, emptyContext, { apiKey: "sk" }, { fetch: mockFetchOk(sse) });
		const events = await collect(stream);
		expect(events.some((event) => event.type === "thinking_start")).toBe(true);
		expect(events.some((event) => event.type === "thinking_delta" && event.delta === "think")).toBe(true);
		const final = await stream.result();
		const thinking = final.content.find((block) => block.type === "thinking");
		expect(thinking && thinking.type === "thinking" ? thinking.thinkingSignature : undefined).toBe(
			JSON.stringify(item),
		);
	});
});
