import { createFauxStream, fauxAssistantMessage, fauxText, fauxToolCall, type Message } from "@z-agent/ai";
import { describe, expect, it } from "vitest";
import {
	type AgentContext,
	type AgentLoopConfig,
	type AgentMessage,
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
		expect(types[types.length - 1]).toBe("agent_end");
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
		expect(collector.types().at(-1)).toBe("agent_end");
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

describe("tools deferred (PR3)", () => {
	it("ends turn without tool_execution when assistant requests tools", async () => {
		const faux = createFauxStream({
			responses: [
				fauxAssistantMessage([fauxToolCall("echo", { x: 1 }, { id: "c1" })], {
					stopReason: "toolUse",
				}),
			],
		});
		const collector = createAgentEventCollector();
		const config: AgentLoopConfig = {
			model: faux.model,
			convertToLlm: identityConvert,
		};

		const newMessages = await runAgentLoop(
			[user("use tool")],
			{ systemPrompt: "", messages: [] },
			config,
			collector.sink,
			undefined,
			faux.streamFn,
		);

		expect(newMessages).toHaveLength(2);
		const assistant = newMessages[1];
		expect(assistant?.role).toBe("assistant");
		if (assistant?.role === "assistant") {
			expect(assistant.stopReason).toBe("toolUse");
		}

		const types = collector.types();
		expect(types).not.toContain("tool_execution_start");
		expect(types).not.toContain("tool_execution_end");
		expect(types.filter((t) => t === "turn_start")).toHaveLength(1);
		expect(types.at(-1)).toBe("agent_end");

		const turnEnd = collector.events.find((e) => e.type === "turn_end");
		if (turnEnd?.type === "turn_end") {
			expect(turnEnd.toolResults).toEqual([]);
		}
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

		const newMessages = await runAgentLoopContinue(context, config, collector.sink, undefined, faux.streamFn);

		expect(newMessages).toHaveLength(1);
		expect(newMessages[0]?.role).toBe("assistant");

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
