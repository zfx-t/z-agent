import { createFauxStream, fauxAssistantMessage, fauxText, fauxToolCall } from "@z-agent/ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent, type AgentEvent, type AgentTool } from "../src/index.ts";

function createDeferred(): {
	promise: Promise<void>;
	resolve: () => void;
} {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe("Agent shell", () => {
	it("creates default state", () => {
		const faux = createFauxStream();
		const agent = new Agent({ streamFn: faux.streamFn, initialState: { model: faux.model } });

		expect(agent.state.systemPrompt).toBe("");
		expect(agent.state.model).toBe(faux.model);
		expect(agent.state.tools).toEqual([]);
		expect(agent.state.messages).toEqual([]);
		expect(agent.state.isStreaming).toBe(false);
		expect(agent.state.streamingMessage).toBeUndefined();
		expect(agent.state.pendingToolCalls).toEqual(new Set());
		expect(agent.state.errorMessage).toBeUndefined();
	});

	it("subscribe receives lifecycle events for a text turn", async () => {
		const faux = createFauxStream({
			responses: [fauxAssistantMessage("Hi there!")],
		});
		const agent = new Agent({
			streamFn: faux.streamFn,
			initialState: { model: faux.model, systemPrompt: "sys" },
		});

		const types: AgentEvent["type"][] = [];
		const unsubscribe = agent.subscribe((event) => {
			types.push(event.type);
		});

		await agent.prompt("Hello");

		expect(types[0]).toBe("agent_start");
		expect(types[1]).toBe("turn_start");
		expect(types).toContain("message_update");
		expect(types[types.length - 2]).toBe("turn_end");
		expect(types[types.length - 1]).toBe("agent_end");

		const withoutUpdates = types.filter((t) => t !== "message_update");
		expect(withoutUpdates).toEqual([
			"agent_start",
			"turn_start",
			"message_start", // user prompt
			"message_end",
			"message_start", // assistant
			"message_end",
			"turn_end",
			"agent_end",
		]);

		expect(agent.state.messages).toHaveLength(2);
		expect(agent.state.messages[0]?.role).toBe("user");
		expect(agent.state.messages[1]?.role).toBe("assistant");
		if (agent.state.messages[1]?.role === "assistant") {
			expect(agent.state.messages[1].content).toEqual([fauxText("Hi there!")]);
			expect(agent.state.messages[1].stopReason).toBe("stop");
		}
		expect(agent.state.isStreaming).toBe(false);

		// Unsubscribe stops delivery
		const countAfter = types.length;
		unsubscribe();
		// No run active; just ensure unsubscribe is callable twice-safe
		unsubscribe();
		expect(types).toHaveLength(countAfter);
	});

	it("prompt(string) builds a user message and completes a text turn", async () => {
		const faux = createFauxStream({
			responses: [fauxAssistantMessage("pong")],
		});
		const agent = new Agent({
			streamFn: faux.streamFn,
			initialState: { model: faux.model },
		});

		await agent.prompt("ping");

		expect(agent.state.messages).toHaveLength(2);
		const userMsg = agent.state.messages[0];
		expect(userMsg?.role).toBe("user");
		if (userMsg?.role === "user") {
			expect(userMsg.content).toEqual([{ type: "text", text: "ping" }]);
		}
		const assistant = agent.state.messages[1];
		expect(assistant?.role).toBe("assistant");
		if (assistant?.role === "assistant") {
			expect(assistant.content).toEqual([fauxText("pong")]);
		}
	});

	it("throws when prompt() is called while streaming (mutex)", async () => {
		const streamStarted = createDeferred();
		const release = createDeferred();
		const faux = createFauxStream({
			responses: [
				async (_ctx, options) => {
					streamStarted.resolve();
					await Promise.race([
						release.promise,
						new Promise<void>((resolve) => {
							if (options?.signal?.aborted) {
								resolve();
								return;
							}
							options?.signal?.addEventListener("abort", () => resolve(), { once: true });
						}),
					]);
					if (options?.signal?.aborted) {
						return fauxAssistantMessage("aborted", { stopReason: "aborted", errorMessage: "aborted" });
					}
					return fauxAssistantMessage("done");
				},
			],
			chunkChars: 1,
		});
		const agent = new Agent({
			streamFn: faux.streamFn,
			initialState: { model: faux.model },
		});

		const first = agent.prompt("first");
		await streamStarted.promise;
		expect(agent.state.isStreaming).toBe(true);

		await expect(agent.prompt("second")).rejects.toThrow(
			"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
		);

		agent.abort();
		await first;
		expect(agent.state.isStreaming).toBe(false);
	});

	it("throws when continue() is called while streaming (mutex)", async () => {
		const streamStarted = createDeferred();
		const release = createDeferred();
		const faux = createFauxStream({
			responses: [
				async (_ctx, options) => {
					streamStarted.resolve();
					await Promise.race([
						release.promise,
						new Promise<void>((resolve) => {
							options?.signal?.addEventListener("abort", () => resolve(), { once: true });
						}),
					]);
					if (options?.signal?.aborted) {
						return fauxAssistantMessage("aborted", { stopReason: "aborted", errorMessage: "aborted" });
					}
					return fauxAssistantMessage("done");
				},
			],
		});
		const agent = new Agent({
			streamFn: faux.streamFn,
			initialState: { model: faux.model },
		});

		const first = agent.prompt("first");
		await streamStarted.promise;

		await expect(agent.continue()).rejects.toThrow(
			"Agent is already processing. Wait for completion before continuing.",
		);

		release.resolve();
		await first;
	});

	it("abort() mid-stream ends with aborted assistant and clears isStreaming", async () => {
		const faux = createFauxStream({
			responses: [fauxAssistantMessage("abcdefghijklmnopqrstuvwxyz")],
			chunkChars: 1,
		});
		const agent = new Agent({
			streamFn: faux.streamFn,
			initialState: { model: faux.model },
		});

		let abortedSignal = false;
		agent.subscribe((event, signal) => {
			if (event.type === "message_update" && !signal.aborted) {
				agent.abort();
			}
			if (event.type === "agent_end") {
				abortedSignal = signal.aborted;
			}
		});

		await agent.prompt("go");

		expect(abortedSignal).toBe(true);
		expect(agent.state.isStreaming).toBe(false);
		const assistant = agent.state.messages.find((m) => m.role === "assistant");
		expect(assistant && "stopReason" in assistant && assistant.stopReason).toBe("aborted");
		expect(agent.state.errorMessage).toBeDefined();
	});

	it("abort() with no active run is a no-op", () => {
		const faux = createFauxStream();
		const agent = new Agent({ streamFn: faux.streamFn, initialState: { model: faux.model } });
		expect(() => agent.abort()).not.toThrow();
	});

	it("continue() resumes after tool results (terminate batch, then continue)", async () => {
		const echoParams = z.object({ text: z.string() });
		const tool: AgentTool<typeof echoParams> = {
			name: "echo",
			label: "Echo",
			description: "echo",
			parameters: echoParams,
			async execute(_id, params) {
				return {
					content: [{ type: "text", text: `echo:${params.text}` }],
					details: {},
					terminate: true,
				};
			},
		};

		const faux = createFauxStream({
			responses: [
				fauxAssistantMessage([fauxToolCall("echo", { text: "hi" }, { id: "c1" })], {
					stopReason: "toolUse",
				}),
				// Used by continue() after tools finished with terminate
				fauxAssistantMessage("after tools"),
			],
		});

		const agent = new Agent({
			streamFn: faux.streamFn,
			initialState: {
				model: faux.model,
				tools: [tool],
			},
		});

		await agent.prompt("use tool");

		// terminate:true stops after tool batch — last messages are assistant + toolResult
		const roles = agent.state.messages.map((m) => m.role);
		expect(roles).toEqual(["user", "assistant", "toolResult"]);
		expect(agent.state.isStreaming).toBe(false);

		await agent.continue();

		const rolesAfter = agent.state.messages.map((m) => m.role);
		expect(rolesAfter).toEqual(["user", "assistant", "toolResult", "assistant"]);
		const last = agent.state.messages[agent.state.messages.length - 1];
		expect(last?.role).toBe("assistant");
		if (last?.role === "assistant") {
			expect(last.content).toEqual([fauxText("after tools")]);
		}
	});

	it("continue() throws when last message is assistant", async () => {
		const faux = createFauxStream({
			responses: [fauxAssistantMessage("done")],
		});
		const agent = new Agent({
			streamFn: faux.streamFn,
			initialState: { model: faux.model },
		});
		await agent.prompt("hi");
		await expect(agent.continue()).rejects.toThrow("Cannot continue from message role: assistant");
	});

	it("continue() throws when transcript is empty", async () => {
		const faux = createFauxStream();
		const agent = new Agent({
			streamFn: faux.streamFn,
			initialState: { model: faux.model },
		});
		await expect(agent.continue()).rejects.toThrow("No messages to continue from");
	});

	it("tracks pendingToolCalls during tool execution", async () => {
		const toolStarted = createDeferred();
		const releaseTool = createDeferred();
		const seenPending: number[] = [];

		const tool: AgentTool = {
			name: "slow",
			label: "Slow",
			description: "slow",
			parameters: z.object({}),
			async execute() {
				toolStarted.resolve();
				await releaseTool.promise;
				return {
					content: [{ type: "text", text: "ok" }],
					details: {},
					terminate: true,
				};
			},
		};

		const faux = createFauxStream({
			responses: [
				fauxAssistantMessage([fauxToolCall("slow", {}, { id: "t1" })], {
					stopReason: "toolUse",
				}),
			],
		});

		const agent = new Agent({
			streamFn: faux.streamFn,
			initialState: { model: faux.model, tools: [tool] },
		});

		agent.subscribe((event) => {
			if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
				seenPending.push(agent.state.pendingToolCalls.size);
			}
		});

		const run = agent.prompt("tool");
		await toolStarted.promise;
		expect(agent.state.pendingToolCalls.has("t1")).toBe(true);
		releaseTool.resolve();
		await run;

		expect(agent.state.pendingToolCalls.size).toBe(0);
		// start added → size 1; end removed → size 0
		expect(seenPending).toEqual([1, 0]);
	});

	it("wires beforeToolCall / afterToolCall / convertToLlm / transformContext", async () => {
		const order: string[] = [];
		const tool: AgentTool = {
			name: "t",
			label: "T",
			description: "t",
			parameters: z.object({ n: z.number() }),
			async execute() {
				order.push("execute");
				return {
					content: [{ type: "text", text: "raw" }],
					details: { v: 1 },
					terminate: true,
				};
			},
		};

		const faux = createFauxStream({
			responses: [
				fauxAssistantMessage([fauxToolCall("t", { n: 1 }, { id: "x" })], {
					stopReason: "toolUse",
				}),
			],
		});

		const agent = new Agent({
			streamFn: faux.streamFn,
			initialState: { model: faux.model, tools: [tool] },
			transformContext: async (messages) => {
				order.push("transform");
				return messages;
			},
			convertToLlm: (messages) => {
				order.push("convert");
				return messages.filter(
					(m): m is import("@z-agent/ai").Message =>
						typeof m === "object" &&
						m !== null &&
						"role" in m &&
						(m.role === "user" || m.role === "assistant" || m.role === "toolResult"),
				);
			},
			beforeToolCall: async () => {
				order.push("before");
				return undefined;
			},
			afterToolCall: async () => {
				order.push("after");
				return {
					content: [{ type: "text", text: "patched" }],
				};
			},
		});

		await agent.prompt("go");

		expect(order).toEqual(["transform", "convert", "before", "execute", "after"]);
		const toolResult = agent.state.messages.find((m) => m.role === "toolResult");
		expect(toolResult?.role).toBe("toolResult");
		if (toolResult?.role === "toolResult") {
			expect(toolResult.content).toEqual([{ type: "text", text: "patched" }]);
		}
	});

	it("state.tools and state.messages assignments copy arrays", () => {
		const faux = createFauxStream();
		const agent = new Agent({ streamFn: faux.streamFn, initialState: { model: faux.model } });
		const tools: AgentTool[] = [];
		agent.state.tools = tools;
		expect(agent.state.tools).not.toBe(tools);
		const messages = [{ role: "user" as const, content: "x", timestamp: 1 }];
		agent.state.messages = messages;
		expect(agent.state.messages).not.toBe(messages);
		expect(agent.state.messages).toEqual(messages);
	});

	it("waitForIdle waits for async agent_end listeners", async () => {
		const barrier = createDeferred();
		const faux = createFauxStream({
			responses: [fauxAssistantMessage("ok")],
		});
		const agent = new Agent({
			streamFn: faux.streamFn,
			initialState: { model: faux.model },
		});

		let listenerDone = false;
		agent.subscribe(async (event) => {
			if (event.type === "agent_end") {
				await barrier.promise;
				listenerDone = true;
			}
		});

		const promptPromise = agent.prompt("hi");
		await new Promise((r) => setTimeout(r, 20));
		expect(agent.state.isStreaming).toBe(true);
		expect(listenerDone).toBe(false);

		barrier.resolve();
		await promptPromise;
		await agent.waitForIdle();
		expect(listenerDone).toBe(true);
		expect(agent.state.isStreaming).toBe(false);
	});
});
