import { createFauxStream, fauxAssistantMessage, fauxText, fauxToolCall, type Message } from "@z-agent/ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	type AgentContext,
	type AgentLoopConfig,
	type AgentMessage,
	type AgentTool,
	createAgentEventCollector,
	runAgentLoop,
	runAgentLoopContinue,
} from "../src/index.ts";

function identityConvert(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(m): m is Message =>
			typeof m === "object" &&
			m !== null &&
			"role" in m &&
			(m.role === "user" || m.role === "assistant" || m.role === "toolResult"),
	);
}

function user(text: string, timestamp = 1): AgentMessage {
	return { role: "user", content: text, timestamp };
}

describe("runAgentLoop text-only", () => {
	it("emits full event sequence for a text turn", async () => {
		const faux = createFauxStream({
			responses: [fauxAssistantMessage("Hi there!")],
		});
		const collector = createAgentEventCollector();
		const context: AgentContext = {
			systemPrompt: "sys",
			messages: [],
		};
		const config: AgentLoopConfig = {
			model: faux.model,
			convertToLlm: identityConvert,
		};
		const prompt = user("Hello");

		const newMessages = await runAgentLoop([prompt], context, config, collector.sink, undefined, faux.streamFn);

		expect(newMessages).toHaveLength(2);
		expect(newMessages[0]?.role).toBe("user");
		expect(newMessages[1]?.role).toBe("assistant");
		if (newMessages[1]?.role === "assistant") {
			expect(newMessages[1].stopReason).toBe("stop");
			expect(newMessages[1].content).toEqual([fauxText("Hi there!")]);
		}

		const types = collector.types();
		// agent_start → turn_start → prompt pair → assistant stream → turn_end → agent_end
		expect(types[0]).toBe("agent_start");
		expect(types[1]).toBe("turn_start");
		expect(types[2]).toBe("message_start"); // prompt
		expect(types[3]).toBe("message_end"); // prompt
		expect(types).toContain("message_update");
		expect(types[types.length - 2]).toBe("turn_end");
		expect(types[types.length - 1]).toBe("agent_end");

		// Exact high-level shape without intermediate update count
		const withoutUpdates = types.filter((t) => t !== "message_update");
		expect(withoutUpdates).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"message_start",
			"message_end",
			"turn_end",
			"agent_end",
		]);

		const turnEnd = collector.events.find((e) => e.type === "turn_end");
		expect(turnEnd?.type).toBe("turn_end");
		if (turnEnd?.type === "turn_end") {
			expect(turnEnd.toolResults).toEqual([]);
		}

		const agentEnd = collector.events.find((e) => e.type === "agent_end");
		if (agentEnd?.type === "agent_end") {
			expect(agentEnd.messages).toHaveLength(2);
		}

		// Context received a copy; original context.messages must stay empty
		expect(context.messages).toHaveLength(0);
	});

	it("emits message_update during stream with assistantMessageEvent", async () => {
		const faux = createFauxStream({
			responses: [fauxAssistantMessage("abc")],
			chunkChars: 1,
		});
		const collector = createAgentEventCollector();
		const config: AgentLoopConfig = {
			model: faux.model,
			convertToLlm: identityConvert,
		};

		await runAgentLoop(
			[user("go")],
			{ systemPrompt: "", messages: [] },
			config,
			collector.sink,
			undefined,
			faux.streamFn,
		);

		const updates = collector.events.filter((e) => e.type === "message_update");
		expect(updates.length).toBeGreaterThan(0);
		for (const u of updates) {
			if (u.type !== "message_update") continue;
			expect(u.message.role).toBe("assistant");
			expect(u.assistantMessageEvent.type).toMatch(/^(text_|thinking_|toolcall_)/);
		}
	});
});

describe("runAgentLoop error / aborted", () => {
	it("ends agent on stopReason error without further turns", async () => {
		const faux = createFauxStream({
			responses: [fauxAssistantMessage("boom", { stopReason: "error", errorMessage: "provider failed" })],
		});
		const collector = createAgentEventCollector();
		const config: AgentLoopConfig = {
			model: faux.model,
			convertToLlm: identityConvert,
		};

		const newMessages = await runAgentLoop(
			[user("x")],
			{ systemPrompt: "", messages: [] },
			config,
			collector.sink,
			undefined,
			faux.streamFn,
		);

		const assistant = newMessages.find((m) => m.role === "assistant");
		expect(assistant && "stopReason" in assistant && assistant.stopReason).toBe("error");

		const types = collector.types();
		const withoutUpdates = types.filter((t) => t !== "message_update");
		expect(withoutUpdates.slice(-2)).toEqual(["turn_end", "agent_end"]);
		expect(types.filter((t) => t === "turn_start")).toHaveLength(1);
		expect(types.filter((t) => t === "agent_end")).toHaveLength(1);
		expect(faux.getPendingResponseCount()).toBe(0);
	});

	it("ends agent on abort mid-stream", async () => {
		const ac = new AbortController();
		const faux = createFauxStream({
			responses: [fauxAssistantMessage("long response that aborts")],
			chunkChars: 1,
		});
		const collector = createAgentEventCollector();
		const config: AgentLoopConfig = {
			model: faux.model,
			convertToLlm: identityConvert,
		};

		// Abort after first update so stream sees signal.aborted
		const sink = async (event: Parameters<typeof collector.sink>[0]) => {
			collector.sink(event);
			if (event.type === "message_update" && !ac.signal.aborted) {
				ac.abort();
			}
		};

		const newMessages = await runAgentLoop(
			[user("x")],
			{ systemPrompt: "", messages: [] },
			config,
			sink,
			ac.signal,
			faux.streamFn,
		);

		const assistant = newMessages.find((m) => m.role === "assistant");
		expect(assistant && "stopReason" in assistant && assistant.stopReason).toBe("aborted");
		const withoutUpdates = collector.types().filter((t) => t !== "message_update");
		expect(withoutUpdates.slice(-2)).toEqual(["turn_end", "agent_end"]);
	});
});

describe("convertToLlm / transformContext", () => {
	it("filters non-LLM roles via convertToLlm", async () => {
		const notification = {
			role: "notification" as const,
			text: "ui only",
			timestamp: 0,
		};

		// Extend AgentMessage via structural cast (declaration merge not registered in test).
		const prior: AgentMessage[] = [notification as unknown as AgentMessage, user("keep me", 2)];

		let seenByConvert: AgentMessage[] = [];
		const faux = createFauxStream({
			responses: [
				(context) => {
					// Provider sees only LLM messages
					expect(context.messages.every((m) => (m.role as string) !== "notification")).toBe(true);
					expect(context.messages.map((m) => m.role)).toEqual(["user", "user"]);
					return fauxAssistantMessage("ok");
				},
			],
		});

		const config: AgentLoopConfig = {
			model: faux.model,
			convertToLlm: (messages) => {
				seenByConvert = [...messages];
				return identityConvert(messages);
			},
		};

		await runAgentLoop(
			[user("prompt", 3)],
			{ systemPrompt: "s", messages: prior },
			config,
			createAgentEventCollector().sink,
			undefined,
			faux.streamFn,
		);

		// convertToLlm receives agent-layer messages including notification + prompts
		expect(seenByConvert.some((m) => (m as { role: string }).role === "notification")).toBe(true);
		expect(seenByConvert.filter((m) => m.role === "user")).toHaveLength(2);
	});

	it("applies transformContext before convertToLlm", async () => {
		const order: string[] = [];
		const faux = createFauxStream({
			responses: [fauxAssistantMessage("y")],
		});
		const config: AgentLoopConfig = {
			model: faux.model,
			transformContext: async (messages) => {
				order.push("transform");
				// Keep only the last message
				return messages.slice(-1);
			},
			convertToLlm: (messages) => {
				order.push("convert");
				expect(messages).toHaveLength(1);
				expect(messages[0]?.role).toBe("user");
				return identityConvert(messages);
			},
		};

		await runAgentLoop(
			[user("a"), user("b")],
			{
				systemPrompt: "",
				messages: [user("old1", 0), user("old2", 0)],
			},
			config,
			createAgentEventCollector().sink,
			undefined,
			faux.streamFn,
		);

		expect(order).toEqual(["transform", "convert"]);
	});
});

describe("sequential tools (prepare → execute → after)", () => {
	const echoSchema = z.object({ value: z.string() });

	function echoTool(
		execute: AgentTool<typeof echoSchema, { value: string }>["execute"],
	): AgentTool<typeof echoSchema, { value: string }> {
		return {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: echoSchema,
			execute,
		};
	}

	it("executes a successful tool then runs another assistant turn", async () => {
		const executed: string[] = [];
		const tool = echoTool(async (_id, params) => {
			executed.push(params.value);
			return {
				content: [{ type: "text", text: `echoed: ${params.value}` }],
				details: { value: params.value },
			};
		});

		const faux = createFauxStream({
			responses: [
				fauxAssistantMessage([fauxToolCall("echo", { value: "hello" }, { id: "c1" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			],
		});
		const collector = createAgentEventCollector();
		const config: AgentLoopConfig = {
			model: faux.model,
			convertToLlm: identityConvert,
		};

		const newMessages = await runAgentLoop(
			[user("use tool")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			config,
			collector.sink,
			undefined,
			faux.streamFn,
		);

		expect(executed).toEqual(["hello"]);
		expect(newMessages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);

		const toolResult = newMessages.find((m) => m.role === "toolResult");
		expect(toolResult?.role === "toolResult" && toolResult.isError).toBe(false);
		expect(toolResult?.role === "toolResult" ? toolResult.content : []).toEqual([
			{ type: "text", text: "echoed: hello" },
		]);

		const types = collector.types().filter((t) => t !== "message_update");
		// tool_execution_start → end → toolResult message pair inside first turn
		expect(types).toContain("tool_execution_start");
		expect(types).toContain("tool_execution_end");
		expect(types.filter((t) => t === "turn_start")).toHaveLength(2);
		expect(types.at(-1)).toBe("agent_end");

		const turnEnds = collector.events.filter((e) => e.type === "turn_end");
		expect(turnEnds).toHaveLength(2);
		if (turnEnds[0]?.type === "turn_end") {
			expect(turnEnds[0].toolResults).toHaveLength(1);
			expect(turnEnds[0].toolResults[0]?.toolCallId).toBe("c1");
		}
		if (turnEnds[1]?.type === "turn_end") {
			expect(turnEnds[1].toolResults).toEqual([]);
		}
	});

	it("rejects invalid args without calling execute", async () => {
		let executed = false;
		const tool = echoTool(async () => {
			executed = true;
			return { content: [{ type: "text", text: "nope" }], details: { value: "x" } };
		});

		const faux = createFauxStream({
			responses: [
				// missing required `value`
				fauxAssistantMessage([fauxToolCall("echo", { wrong: 1 }, { id: "bad" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("recovered"),
			],
		});
		const collector = createAgentEventCollector();
		const config: AgentLoopConfig = {
			model: faux.model,
			convertToLlm: identityConvert,
		};

		const newMessages = await runAgentLoop(
			[user("bad args")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			config,
			collector.sink,
			undefined,
			faux.streamFn,
		);

		expect(executed).toBe(false);
		const toolResult = newMessages.find((m) => m.role === "toolResult");
		expect(toolResult?.role === "toolResult" && toolResult.isError).toBe(true);
		const text =
			toolResult?.role === "toolResult"
				? toolResult.content.find((c) => c.type === "text" && "text" in c)
				: undefined;
		expect(text && "text" in text ? text.text : "").toContain("Validation failed");
		expect(text && "text" in text ? text.text : "").toContain("echo");

		const toolEnd = collector.events.find((e) => e.type === "tool_execution_end");
		expect(toolEnd?.type === "tool_execution_end" && toolEnd.isError).toBe(true);
		// Still continues for another LLM turn with the error result
		expect(newMessages.filter((m) => m.role === "assistant")).toHaveLength(2);
	});

	it("blocks execute when beforeToolCall returns block", async () => {
		let executed = false;
		const tool = echoTool(async () => {
			executed = true;
			return { content: [{ type: "text", text: "nope" }], details: { value: "x" } };
		});

		const faux = createFauxStream({
			responses: [
				fauxAssistantMessage([fauxToolCall("echo", { value: "hi" }, { id: "b1" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("after block"),
			],
		});
		const collector = createAgentEventCollector();
		const config: AgentLoopConfig = {
			model: faux.model,
			convertToLlm: identityConvert,
			beforeToolCall: async () => ({ block: true, reason: "Blocked by policy" }),
		};

		const newMessages = await runAgentLoop(
			[user("block me")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			config,
			collector.sink,
			undefined,
			faux.streamFn,
		);

		expect(executed).toBe(false);
		const toolResult = newMessages.find((m) => m.role === "toolResult");
		expect(toolResult?.role === "toolResult" && toolResult.isError).toBe(true);
		expect(toolResult?.role === "toolResult" ? toolResult.content : []).toContainEqual({
			type: "text",
			text: "Blocked by policy",
		});
		// Non-terminating block still allows follow-up LLM turn
		expect(newMessages.filter((m) => m.role === "assistant")).toHaveLength(2);
	});

	it("applies afterToolCall field-by-field overrides", async () => {
		const tool = echoTool(async (_id, params) => ({
			content: [{ type: "text", text: `raw: ${params.value}` }],
			details: { value: params.value, original: true },
		}));

		const faux = createFauxStream({
			responses: [
				fauxAssistantMessage([fauxToolCall("echo", { value: "x" }, { id: "a1" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			],
		});
		const config: AgentLoopConfig = {
			model: faux.model,
			convertToLlm: identityConvert,
			afterToolCall: async () => ({
				content: [{ type: "text", text: "overridden" }],
				details: { patched: true },
				isError: false,
			}),
		};

		const newMessages = await runAgentLoop(
			[user("after")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			config,
			createAgentEventCollector().sink,
			undefined,
			faux.streamFn,
		);

		const toolResult = newMessages.find((m) => m.role === "toolResult");
		expect(toolResult?.role === "toolResult" ? toolResult.content : []).toEqual([
			{ type: "text", text: "overridden" },
		]);
		expect(toolResult?.role === "toolResult" ? toolResult.details : undefined).toEqual({ patched: true });
		expect(toolResult?.role === "toolResult" && toolResult.isError).toBe(false);
	});

	it("fails entire tool batch without execute when stopReason is length", async () => {
		const executed: string[] = [];
		const tool = echoTool(async (_id, params) => {
			executed.push(params.value);
			return {
				content: [{ type: "text", text: `echoed: ${params.value}` }],
				details: { value: params.value },
			};
		});

		const faux = createFauxStream({
			responses: [
				fauxAssistantMessage(
					[
						fauxToolCall("echo", { value: "hel" }, { id: "t1" }),
						fauxToolCall("echo", { value: "lo" }, { id: "t2" }),
					],
					{ stopReason: "length" },
				),
				fauxAssistantMessage("re-issue ok"),
			],
		});
		const collector = createAgentEventCollector();
		const config: AgentLoopConfig = {
			model: faux.model,
			convertToLlm: identityConvert,
		};

		const newMessages = await runAgentLoop(
			[user("truncated")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			config,
			collector.sink,
			undefined,
			faux.streamFn,
		);

		expect(executed).toEqual([]);
		const toolResults = newMessages.filter((m) => m.role === "toolResult");
		expect(toolResults).toHaveLength(2);
		for (const tr of toolResults) {
			if (tr.role !== "toolResult") continue;
			expect(tr.isError).toBe(true);
			const text = tr.content.find((c) => c.type === "text");
			expect(text && "text" in text ? text.text : "").toContain("output token limit");
		}

		const toolEnds = collector.events.filter((e) => e.type === "tool_execution_end");
		expect(toolEnds).toHaveLength(2);
		expect(toolEnds.every((e) => e.type === "tool_execution_end" && e.isError)).toBe(true);

		// Loop continues so the model can re-issue complete tool calls
		expect(newMessages.filter((m) => m.role === "assistant")).toHaveLength(2);
	});

	it("stops further LLM calls when every finalized result has terminate:true", async () => {
		const tool = echoTool(async (_id, params) => ({
			content: [{ type: "text", text: `echoed: ${params.value}` }],
			details: { value: params.value },
			terminate: true,
		}));

		const faux = createFauxStream({
			responses: [
				fauxAssistantMessage([fauxToolCall("echo", { value: "stop" }, { id: "term" })], {
					stopReason: "toolUse",
				}),
				// Must not be consumed
				fauxAssistantMessage("should not run"),
			],
		});
		const config: AgentLoopConfig = {
			model: faux.model,
			convertToLlm: identityConvert,
		};

		const newMessages = await runAgentLoop(
			[user("terminate")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			config,
			createAgentEventCollector().sink,
			undefined,
			faux.streamFn,
		);

		expect(newMessages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(faux.getPendingResponseCount()).toBe(1);
	});

	it("returns error toolResult for unknown tool without execute", async () => {
		const faux = createFauxStream({
			responses: [
				fauxAssistantMessage([fauxToolCall("missing", { a: 1 }, { id: "u1" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("ok"),
			],
		});
		const config: AgentLoopConfig = {
			model: faux.model,
			convertToLlm: identityConvert,
		};

		const newMessages = await runAgentLoop(
			[user("unknown")],
			{ systemPrompt: "", messages: [], tools: [] },
			config,
			createAgentEventCollector().sink,
			undefined,
			faux.streamFn,
		);

		const toolResult = newMessages.find((m) => m.role === "toolResult");
		expect(toolResult?.role === "toolResult" && toolResult.isError).toBe(true);
		expect(toolResult?.role === "toolResult" ? toolResult.content : []).toContainEqual({
			type: "text",
			text: "Tool missing not found",
		});
	});

	it("emits toolResult message_start/end around tool_execution_end", async () => {
		const tool = echoTool(async (_id, params) => ({
			content: [{ type: "text", text: params.value }],
			details: { value: params.value },
		}));
		const faux = createFauxStream({
			responses: [
				fauxAssistantMessage([fauxToolCall("echo", { value: "z" }, { id: "ord" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			],
		});
		const collector = createAgentEventCollector();
		await runAgentLoop(
			[user("order")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			// Sequential: end and toolResult message pair are adjacent per call
			{ model: faux.model, convertToLlm: identityConvert, toolExecution: "sequential" },
			collector.sink,
			undefined,
			faux.streamFn,
		);

		const types = collector.types().filter((t) => t !== "message_update");
		const startIdx = types.indexOf("tool_execution_start");
		const endIdx = types.indexOf("tool_execution_end");
		// After tool_execution_end: message_start + message_end for toolResult
		expect(startIdx).toBeGreaterThan(-1);
		expect(endIdx).toBeGreaterThan(startIdx);
		expect(types[endIdx + 1]).toBe("message_start");
		expect(types[endIdx + 2]).toBe("message_end");
	});

	it("runs tools sequentially when toolExecution is sequential", async () => {
		const schema = z.object({ value: z.string() });
		let firstResolved = false;
		let parallelObserved = false;
		let releaseFirst: (() => void) | undefined;
		const firstDone = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const tool: AgentTool<typeof schema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo",
			parameters: schema,
			async execute(_id, params) {
				if (params.value === "first") {
					await firstDone;
					firstResolved = true;
				}
				if (params.value === "second" && !firstResolved) {
					parallelObserved = true;
				}
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const faux = createFauxStream({
			responses: [
				fauxAssistantMessage(
					[
						fauxToolCall("echo", { value: "first" }, { id: "tool-1" }),
						fauxToolCall("echo", { value: "second" }, { id: "tool-2" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			],
		});
		const collector = createAgentEventCollector();

		const runPromise = runAgentLoop(
			[user("seq")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			{ model: faux.model, convertToLlm: identityConvert, toolExecution: "sequential" },
			collector.sink,
			undefined,
			faux.streamFn,
		);
		// Release the first tool after a short delay so a parallel path would race
		setTimeout(() => releaseFirst?.(), 20);
		await runPromise;

		expect(parallelObserved).toBe(false);
		const toolResultIds = collector.events.flatMap((event) => {
			if (event.type !== "message_end" || event.message.role !== "toolResult") return [];
			return [event.message.toolCallId];
		});
		expect(toolResultIds).toEqual(["tool-1", "tool-2"]);
	});
});

describe("parallel three-phase tools", () => {
	const schema = z.object({ value: z.string() });

	it("emits tool_execution_end in completion order but toolResults in source order", async () => {
		let firstResolved = false;
		let parallelObserved = false;
		let releaseFirst: (() => void) | undefined;
		const firstDone = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const tool: AgentTool<typeof schema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo",
			parameters: schema,
			async execute(_id, params) {
				if (params.value === "first") {
					await firstDone;
					firstResolved = true;
				}
				if (params.value === "second" && !firstResolved) {
					parallelObserved = true;
				}
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const faux = createFauxStream({
			responses: [
				fauxAssistantMessage(
					[
						fauxToolCall("echo", { value: "first" }, { id: "tool-1" }),
						fauxToolCall("echo", { value: "second" }, { id: "tool-2" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			],
		});
		const collector = createAgentEventCollector();

		const runPromise = runAgentLoop(
			[user("parallel")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			// default toolExecution is parallel; set explicitly for clarity
			{ model: faux.model, convertToLlm: identityConvert, toolExecution: "parallel" },
			collector.sink,
			undefined,
			faux.streamFn,
		);
		setTimeout(() => releaseFirst?.(), 20);
		const newMessages = await runPromise;

		expect(parallelObserved).toBe(true);

		const toolExecutionEndIds = collector.events.flatMap((event) => {
			if (event.type !== "tool_execution_end") return [];
			return [event.toolCallId];
		});
		const toolResultIds = collector.events.flatMap((event) => {
			if (event.type !== "message_end" || event.message.role !== "toolResult") return [];
			return [event.message.toolCallId];
		});
		const turnToolResultIds = collector.events.flatMap((event) => {
			if (event.type !== "turn_end") return [];
			return event.toolResults.map((tr) => tr.toolCallId);
		});

		// Second finishes first (no wait); first after release → completion order ends
		expect(toolExecutionEndIds).toEqual(["tool-2", "tool-1"]);
		// Artifact messages and transcript stay assistant source order
		expect(toolResultIds).toEqual(["tool-1", "tool-2"]);
		expect(turnToolResultIds).toEqual(["tool-1", "tool-2"]);
		expect(
			newMessages.filter((m) => m.role === "toolResult").map((m) => (m.role === "toolResult" ? m.toolCallId : "")),
		).toEqual(["tool-1", "tool-2"]);
	});

	it("defaults to parallel when toolExecution is omitted", async () => {
		let firstResolved = false;
		let parallelObserved = false;
		let releaseFirst: (() => void) | undefined;
		const firstDone = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const tool: AgentTool<typeof schema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo",
			parameters: schema,
			async execute(_id, params) {
				if (params.value === "first") {
					await firstDone;
					firstResolved = true;
				}
				if (params.value === "second" && !firstResolved) {
					parallelObserved = true;
				}
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const faux = createFauxStream({
			responses: [
				fauxAssistantMessage(
					[
						fauxToolCall("echo", { value: "first" }, { id: "tool-1" }),
						fauxToolCall("echo", { value: "second" }, { id: "tool-2" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			],
		});

		const runPromise = runAgentLoop(
			[user("default parallel")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			{ model: faux.model, convertToLlm: identityConvert },
			createAgentEventCollector().sink,
			undefined,
			faux.streamFn,
		);
		setTimeout(() => releaseFirst?.(), 20);
		await runPromise;

		expect(parallelObserved).toBe(true);
	});

	it("forces sequential when any tool has executionMode sequential", async () => {
		let firstResolved = false;
		let parallelObserved = false;
		let releaseFirst: (() => void) | undefined;
		const firstDone = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const slowTool: AgentTool<typeof schema, { value: string }> = {
			name: "slow",
			label: "Slow",
			description: "Slow",
			parameters: schema,
			executionMode: "sequential",
			async execute(_id, params) {
				if (params.value === "first") {
					await firstDone;
					firstResolved = true;
				}
				if (params.value === "second" && !firstResolved) {
					parallelObserved = true;
				}
				return {
					content: [{ type: "text", text: `slow: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const faux = createFauxStream({
			responses: [
				fauxAssistantMessage(
					[
						fauxToolCall("slow", { value: "first" }, { id: "tool-1" }),
						fauxToolCall("slow", { value: "second" }, { id: "tool-2" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			],
		});
		const collector = createAgentEventCollector();

		const runPromise = runAgentLoop(
			[user("force seq")],
			{ systemPrompt: "", messages: [], tools: [slowTool] },
			// parallel config, but tool forces sequential
			{ model: faux.model, convertToLlm: identityConvert, toolExecution: "parallel" },
			collector.sink,
			undefined,
			faux.streamFn,
		);
		setTimeout(() => releaseFirst?.(), 20);
		await runPromise;

		expect(parallelObserved).toBe(false);
		const toolResultIds = collector.events.flatMap((event) => {
			if (event.type !== "message_end" || event.message.role !== "toolResult") return [];
			return [event.message.toolCallId];
		});
		expect(toolResultIds).toEqual(["tool-1", "tool-2"]);
	});

	it("emits all tool_execution_end before any toolResult messages in parallel mode", async () => {
		const tool: AgentTool<typeof schema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo",
			parameters: schema,
			async execute(_id, params) {
				return {
					content: [{ type: "text", text: params.value }],
					details: { value: params.value },
				};
			},
		};

		const faux = createFauxStream({
			responses: [
				fauxAssistantMessage(
					[fauxToolCall("echo", { value: "a" }, { id: "a" }), fauxToolCall("echo", { value: "b" }, { id: "b" })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			],
		});
		const collector = createAgentEventCollector();
		await runAgentLoop(
			[user("phase3")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			{ model: faux.model, convertToLlm: identityConvert, toolExecution: "parallel" },
			collector.sink,
			undefined,
			faux.streamFn,
		);

		const relevant = collector.events.filter((e) => e.type !== "message_update");
		const endIndices = relevant.map((e, i) => (e.type === "tool_execution_end" ? i : -1)).filter((i) => i >= 0);
		const firstToolResultMsg = relevant.findIndex(
			(e) => e.type === "message_start" && e.message.role === "toolResult",
		);
		// Both ends before first toolResult message_start (phase 3 after concurrent execute)
		expect(endIndices).toHaveLength(2);
		expect(firstToolResultMsg).toBeGreaterThan(Math.max(...endIndices));
	});
});

describe("runAgentLoopContinue", () => {
	it("continues from existing user context without re-emitting prompts", async () => {
		const faux = createFauxStream({
			responses: [fauxAssistantMessage("continued")],
		});
		const collector = createAgentEventCollector();
		const config: AgentLoopConfig = {
			model: faux.model,
			convertToLlm: identityConvert,
		};
		const context: AgentContext = {
			systemPrompt: "s",
			messages: [user("already there")],
		};
		const priorLength = context.messages.length;

		const newMessages = await runAgentLoopContinue(context, config, collector.sink, undefined, faux.streamFn);

		expect(newMessages).toHaveLength(1);
		expect(newMessages[0]?.role).toBe("assistant");
		// Isolation: continue copies the transcript; caller's array is unchanged.
		expect(context.messages).toHaveLength(priorLength);
		expect(context.messages.every((m) => m.role !== "assistant")).toBe(true);

		const withoutUpdates = collector.types().filter((t) => t !== "message_update");
		expect(withoutUpdates).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"turn_end",
			"agent_end",
		]);
	});

	it("rejects empty context and trailing assistant", async () => {
		const faux = createFauxStream();
		const config: AgentLoopConfig = {
			model: faux.model,
			convertToLlm: identityConvert,
		};
		const sink = createAgentEventCollector().sink;

		await expect(
			runAgentLoopContinue({ systemPrompt: "", messages: [] }, config, sink, undefined, faux.streamFn),
		).rejects.toThrow(/no messages/);

		await expect(
			runAgentLoopContinue(
				{
					systemPrompt: "",
					messages: [fauxAssistantMessage("last")],
				},
				config,
				sink,
				undefined,
				faux.streamFn,
			),
		).rejects.toThrow(/assistant/);
	});
});

describe("steering and follow-up drains", () => {
	it("injects steering after tools finish, before the next assistant turn", async () => {
		const executed: string[] = [];
		const tool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "echo",
			parameters: z.object({ value: z.string() }),
			async execute(_id, params) {
				executed.push((params as { value: string }).value);
				return {
					content: [{ type: "text", text: `ok:${(params as { value: string }).value}` }],
					details: {},
				};
			},
		};

		const interrupt = user("interrupt", 99);
		let steeringDelivered = false;
		let sawInterruptInContext = false;

		const faux = createFauxStream({
			responses: [
				fauxAssistantMessage(
					[
						fauxToolCall("echo", { value: "first" }, { id: "tool-1" }),
						fauxToolCall("echo", { value: "second" }, { id: "tool-2" }),
					],
					{ stopReason: "toolUse" },
				),
				(ctx) => {
					sawInterruptInContext = ctx.messages.some(
						(m) =>
							m.role === "user" &&
							(m.content === "interrupt" || JSON.stringify(m.content).includes("interrupt")),
					);
					return fauxAssistantMessage("done");
				},
			],
		});

		const collector = createAgentEventCollector();
		const config: AgentLoopConfig = {
			model: faux.model,
			convertToLlm: identityConvert,
			toolExecution: "sequential",
			getSteeringMessages: async () => {
				// After both tools have run, deliver steering once (post turn_end poll).
				if (executed.length >= 2 && !steeringDelivered) {
					steeringDelivered = true;
					return [interrupt];
				}
				return [];
			},
		};

		await runAgentLoop(
			[user("start")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			config,
			collector.sink,
			undefined,
			faux.streamFn,
		);

		// Both tools run before steering injection.
		expect(executed).toEqual(["first", "second"]);
		expect(sawInterruptInContext).toBe(true);

		const eventSequence = collector.events.flatMap((event) => {
			if (event.type !== "message_start") return [];
			if (event.message.role === "toolResult" && "toolCallId" in event.message) {
				return [`tool:${event.message.toolCallId}`];
			}
			if (event.message.role === "user") {
				const content = event.message.content;
				if (typeof content === "string") return [content];
			}
			return [];
		});
		expect(eventSequence.indexOf("tool:tool-1")).toBeLessThan(eventSequence.indexOf("interrupt"));
		expect(eventSequence.indexOf("tool:tool-2")).toBeLessThan(eventSequence.indexOf("interrupt"));
	});

	it("does not inject follow-up until natural stop (no tools, no steering)", async () => {
		const tool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "echo",
			parameters: z.object({ value: z.string() }),
			async execute(_id, params) {
				return {
					content: [{ type: "text", text: `ok:${(params as { value: string }).value}` }],
					details: {},
				};
			},
		};

		let steeringPolls = 0;
		let followUpPolls = 0;
		let llmCalls = 0;
		const followUpMsg = user("follow-up", 50);

		const faux = createFauxStream({
			responses: [
				() => {
					llmCalls++;
					return fauxAssistantMessage([fauxToolCall("echo", { value: "a" }, { id: "t1" })], {
						stopReason: "toolUse",
					});
				},
				() => {
					llmCalls++;
					return fauxAssistantMessage("after tools");
				},
				() => {
					llmCalls++;
					return fauxAssistantMessage("after follow-up");
				},
			],
		});

		const collector = createAgentEventCollector();
		const config: AgentLoopConfig = {
			model: faux.model,
			convertToLlm: identityConvert,
			getSteeringMessages: async () => {
				steeringPolls++;
				return [];
			},
			getFollowUpMessages: async () => {
				followUpPolls++;
				return followUpPolls === 1 ? [followUpMsg] : [];
			},
		};

		const newMessages = await runAgentLoop(
			[user("start")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			config,
			collector.sink,
			undefined,
			faux.streamFn,
		);

		// Initial steering + after turn1 (tools) + after turn2 (text) = 3 steering polls.
		// Follow-up only once agent would stop (after turn2 text, no tools/steering).
		expect(llmCalls).toBe(3);
		expect(followUpPolls).toBeGreaterThanOrEqual(1);
		expect(steeringPolls).toBeGreaterThanOrEqual(2);

		const roles = newMessages.map((m) => m.role);
		// user, assistant(tool), toolResult, assistant(text), follow-up user, assistant(text)
		expect(roles).toEqual(["user", "assistant", "toolResult", "assistant", "user", "assistant"]);

		// Follow-up user message appears after the first natural stop assistant.
		const userTexts = newMessages
			.filter((m) => m.role === "user")
			.map((m) => (typeof m.content === "string" ? m.content : ""));
		expect(userTexts).toEqual(["start", "follow-up"]);
	});

	it("drains follow-up only after steering is exhausted", async () => {
		let call = 0;
		const reply = () => {
			call++;
			return fauxAssistantMessage(`reply-${call}`);
		};
		const faux = createFauxStream({
			// start+s1, s2, follow → 3 turns (FIFO queue, one entry each)
			responses: [reply, reply, reply],
		});

		let steeringLeft = [user("steer-1", 2), user("steer-2", 3)];
		let followUpLeft = [user("follow", 4)];
		const followUpPollOrder: string[] = [];

		const collector = createAgentEventCollector();
		const config: AgentLoopConfig = {
			model: faux.model,
			convertToLlm: identityConvert,
			// one-at-a-time style drains in the callbacks
			getSteeringMessages: async () => {
				if (steeringLeft.length === 0) return [];
				const next = steeringLeft[0]!;
				steeringLeft = steeringLeft.slice(1);
				return [next];
			},
			getFollowUpMessages: async () => {
				followUpPollOrder.push(`steering-remaining=${steeringLeft.length}`);
				if (followUpLeft.length === 0) return [];
				const next = followUpLeft[0]!;
				followUpLeft = followUpLeft.slice(1);
				return [next];
			},
		};

		const newMessages = await runAgentLoop(
			[user("start", 1)],
			{ systemPrompt: "", messages: [] },
			config,
			collector.sink,
			undefined,
			faux.streamFn,
		);

		// Follow-up only polled when steering queue empty.
		expect(followUpPollOrder.every((s) => s === "steering-remaining=0")).toBe(true);

		const userTexts = newMessages
			.filter((m) => m.role === "user")
			.map((m) => (typeof m.content === "string" ? m.content : ""));
		expect(userTexts).toEqual(["start", "steer-1", "steer-2", "follow"]);
		// Initial drain injects s1 before first assistant; s2 then follow → 3 LLM calls.
		expect(call).toBe(3);
	});
});
