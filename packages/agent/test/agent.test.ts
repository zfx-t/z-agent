import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent, type AgentEvent, type AgentTool } from "../src/index.ts";
import {
	createScriptedStream,
	scriptedAssistantMessage,
	scriptedText,
	scriptedToolCall,
} from "./helpers/scripted-stream.ts";

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
		const scripted = createScriptedStream();
		const agent = new Agent({ streamFn: scripted.streamFn, initialState: { model: scripted.model } });

		expect(agent.state.systemPrompt).toBe("");
		expect(agent.state.model).toBe(scripted.model);
		expect(agent.state.tools).toEqual([]);
		expect(agent.state.messages).toEqual([]);
		expect(agent.state.isStreaming).toBe(false);
		expect(agent.state.streamingMessage).toBeUndefined();
		expect(agent.state.pendingToolCalls).toEqual(new Set());
		expect(agent.state.errorMessage).toBeUndefined();
		expect(agent.state.thinkingLevel).toBe("off");
	});

	it("accepts initial thinkingLevel and allows assignment", () => {
		const scripted = createScriptedStream();
		const agent = new Agent({
			streamFn: scripted.streamFn,
			initialState: { model: scripted.model, thinkingLevel: "low" },
		});
		expect(agent.state.thinkingLevel).toBe("low");
		agent.state.thinkingLevel = "high";
		expect(agent.state.thinkingLevel).toBe("high");
	});

	it("subscribe receives lifecycle events for a text turn", async () => {
		const scripted = createScriptedStream({
			responses: [scriptedAssistantMessage("Hi there!")],
		});
		const agent = new Agent({
			streamFn: scripted.streamFn,
			initialState: { model: scripted.model, systemPrompt: "sys" },
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
			expect(agent.state.messages[1].content).toEqual([scriptedText("Hi there!")]);
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
		const scripted = createScriptedStream({
			responses: [scriptedAssistantMessage("pong")],
		});
		const agent = new Agent({
			streamFn: scripted.streamFn,
			initialState: { model: scripted.model },
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
			expect(assistant.content).toEqual([scriptedText("pong")]);
		}
	});

	it("throws when prompt() is called while streaming (mutex)", async () => {
		const streamStarted = createDeferred();
		const release = createDeferred();
		const scripted = createScriptedStream({
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
						return scriptedAssistantMessage("aborted", { stopReason: "aborted", errorMessage: "aborted" });
					}
					return scriptedAssistantMessage("done");
				},
			],
			chunkChars: 1,
		});
		const agent = new Agent({
			streamFn: scripted.streamFn,
			initialState: { model: scripted.model },
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

	it("throws when reset() is called while streaming without clearing the transcript", async () => {
		const streamStarted = createDeferred();
		const release = createDeferred();
		const scripted = createScriptedStream({
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
						return scriptedAssistantMessage("aborted", { stopReason: "aborted", errorMessage: "aborted" });
					}
					return scriptedAssistantMessage("done");
				},
			],
		});
		const agent = new Agent({
			streamFn: scripted.streamFn,
			initialState: { model: scripted.model },
		});

		const first = agent.prompt("hello");
		await streamStarted.promise;
		expect(agent.state.isStreaming).toBe(true);
		expect(agent.state.messages.map((m) => m.role)).toEqual(["user"]);

		expect(() => agent.reset()).toThrow("Agent is already processing. Wait for completion before resetting.");
		expect(agent.state.isStreaming).toBe(true);
		expect(agent.state.messages.map((m) => m.role)).toEqual(["user"]);

		release.resolve();
		await first;
		expect(agent.state.isStreaming).toBe(false);
		expect(agent.state.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
	});

	it("throws when continue() is called while streaming (mutex)", async () => {
		const streamStarted = createDeferred();
		const release = createDeferred();
		const scripted = createScriptedStream({
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
						return scriptedAssistantMessage("aborted", { stopReason: "aborted", errorMessage: "aborted" });
					}
					return scriptedAssistantMessage("done");
				},
			],
		});
		const agent = new Agent({
			streamFn: scripted.streamFn,
			initialState: { model: scripted.model },
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
		const scripted = createScriptedStream({
			responses: [scriptedAssistantMessage("abcdefghijklmnopqrstuvwxyz")],
			chunkChars: 1,
		});
		const agent = new Agent({
			streamFn: scripted.streamFn,
			initialState: { model: scripted.model },
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
		const scripted = createScriptedStream();
		const agent = new Agent({ streamFn: scripted.streamFn, initialState: { model: scripted.model } });
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

		const scripted = createScriptedStream({
			responses: [
				scriptedAssistantMessage([scriptedToolCall("echo", { text: "hi" }, { id: "c1" })], {
					stopReason: "toolUse",
				}),
				// Used by continue() after tools finished with terminate
				scriptedAssistantMessage("after tools"),
			],
		});

		const agent = new Agent({
			streamFn: scripted.streamFn,
			initialState: {
				model: scripted.model,
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
			expect(last.content).toEqual([scriptedText("after tools")]);
		}
	});

	it("continue() throws when last message is assistant", async () => {
		const scripted = createScriptedStream({
			responses: [scriptedAssistantMessage("done")],
		});
		const agent = new Agent({
			streamFn: scripted.streamFn,
			initialState: { model: scripted.model },
		});
		await agent.prompt("hi");
		await expect(agent.continue()).rejects.toThrow("Cannot continue from message role: assistant");
	});

	it("continue() throws when transcript is empty", async () => {
		const scripted = createScriptedStream();
		const agent = new Agent({
			streamFn: scripted.streamFn,
			initialState: { model: scripted.model },
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

		const scripted = createScriptedStream({
			responses: [
				scriptedAssistantMessage([scriptedToolCall("slow", {}, { id: "t1" })], {
					stopReason: "toolUse",
				}),
			],
		});

		const agent = new Agent({
			streamFn: scripted.streamFn,
			initialState: { model: scripted.model, tools: [tool] },
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

	it("wires prepareContext / transformContext / convertToLlm and tool hooks", async () => {
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

		const scripted = createScriptedStream({
			responses: [
				scriptedAssistantMessage([scriptedToolCall("t", { n: 1 }, { id: "x" })], {
					stopReason: "toolUse",
				}),
			],
		});

		const agent = new Agent({
			streamFn: scripted.streamFn,
			initialState: { model: scripted.model, tools: [tool] },
			prepareContext: async (context) => {
				order.push("prepare");
				return { ...context, messages: context.messages.slice() };
			},
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

		expect(order).toEqual(["prepare", "transform", "convert", "before", "execute", "after"]);
		expect(agent.prepareContext).toBeDefined();
		const toolResult = agent.state.messages.find((m) => m.role === "toolResult");
		expect(toolResult?.role).toBe("toolResult");
		if (toolResult?.role === "toolResult") {
			expect(toolResult.content).toEqual([{ type: "text", text: "patched" }]);
		}
	});

	it("state.tools and state.messages assignments copy arrays", () => {
		const scripted = createScriptedStream();
		const agent = new Agent({ streamFn: scripted.streamFn, initialState: { model: scripted.model } });
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
		const scripted = createScriptedStream({
			responses: [scriptedAssistantMessage("ok")],
		});
		const agent = new Agent({
			streamFn: scripted.streamFn,
			initialState: { model: scripted.model },
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

	it("queues steer/followUp without adding to transcript until drain", () => {
		const scripted = createScriptedStream();
		const agent = new Agent({ streamFn: scripted.streamFn, initialState: { model: scripted.model } });

		const steerMsg = { role: "user" as const, content: "steer", timestamp: 1 };
		const followMsg = { role: "user" as const, content: "follow", timestamp: 2 };
		agent.steer(steerMsg);
		agent.followUp(followMsg);

		expect(agent.state.messages).toEqual([]);
		expect(agent.hasQueuedMessages()).toBe(true);
		expect(agent.steeringMode).toBe("one-at-a-time");
		expect(agent.followUpMode).toBe("one-at-a-time");

		agent.clearAllQueues();
		expect(agent.hasQueuedMessages()).toBe(false);
	});

	it("steer mid-run injects before next assistant turn after tools", async () => {
		const toolStarted = createDeferred();
		const releaseTool = createDeferred();
		const tool: AgentTool = {
			name: "slow",
			label: "Slow",
			description: "slow",
			parameters: z.object({}),
			async execute() {
				toolStarted.resolve();
				await releaseTool.promise;
				return {
					content: [{ type: "text", text: "tool-done" }],
					details: {},
				};
			},
		};

		let llmCalls = 0;
		const contexts: string[][] = [];
		const scripted = createScriptedStream({
			responses: [
				() => {
					llmCalls++;
					return scriptedAssistantMessage([scriptedToolCall("slow", {}, { id: "t1" })], {
						stopReason: "toolUse",
					});
				},
				(ctx) => {
					llmCalls++;
					contexts.push(
						ctx.messages.map((m) => {
							if (m.role === "user") {
								return typeof m.content === "string"
									? `user:${m.content}`
									: `user:${JSON.stringify(m.content)}`;
							}
							return m.role;
						}),
					);
					return scriptedAssistantMessage("after-steer");
				},
			],
		});

		const agent = new Agent({
			streamFn: scripted.streamFn,
			initialState: { model: scripted.model, tools: [tool] },
		});

		const run = agent.prompt("start");
		await toolStarted.promise;
		agent.steer({
			role: "user",
			content: "steering-mid",
			timestamp: Date.now(),
		});
		releaseTool.resolve();
		await run;

		expect(llmCalls).toBe(2);
		// Second LLM call sees toolResult then steering user message.
		const secondCtx = contexts[0] ?? [];
		expect(secondCtx).toContain("toolResult");
		expect(secondCtx.some((r) => r.includes("steering-mid"))).toBe(true);

		const roles = agent.state.messages.map((m) => m.role);
		expect(roles).toEqual(["user", "assistant", "toolResult", "user", "assistant"]);
		expect(agent.hasQueuedMessages()).toBe(false);
	});

	it("followUp only runs after natural stop, not mid-tool turn", async () => {
		const toolStarted = createDeferred();
		const releaseTool = createDeferred();
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
				};
			},
		};

		let llmCalls = 0;
		const scripted = createScriptedStream({
			responses: [
				() => {
					llmCalls++;
					return scriptedAssistantMessage([scriptedToolCall("slow", {}, { id: "t1" })], {
						stopReason: "toolUse",
					});
				},
				() => {
					llmCalls++;
					return scriptedAssistantMessage("natural-stop");
				},
				() => {
					llmCalls++;
					return scriptedAssistantMessage("after-follow");
				},
			],
		});

		const agent = new Agent({
			streamFn: scripted.streamFn,
			initialState: { model: scripted.model, tools: [tool] },
		});

		const run = agent.prompt("go");
		await toolStarted.promise;
		// Queue follow-up while tools still running — must wait for natural stop.
		agent.followUp({
			role: "user",
			content: "follow-later",
			timestamp: Date.now(),
		});
		// Also queue a steering message to prove follow-up waits for both tools and steering.
		agent.steer({
			role: "user",
			content: "steer-first",
			timestamp: Date.now(),
		});
		releaseTool.resolve();
		await run;

		// tool turn → steer inject + assistant → natural stop → follow-up inject + assistant
		expect(llmCalls).toBe(3);

		const userContents = agent.state.messages
			.filter((m) => m.role === "user")
			.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
		// prompt builds content as text block array
		expect(userContents.some((c) => c.includes("go") || c === "go")).toBe(true);
		expect(userContents).toContain("steer-first");
		expect(userContents).toContain("follow-later");
		// Order: prompt, then steer (after tools), then follow (after natural stop)
		const steerIdx = userContents.indexOf("steer-first");
		const followIdx = userContents.indexOf("follow-later");
		expect(steerIdx).toBeLessThan(followIdx);
	});

	it("one-at-a-time drains one steering message per drain point", async () => {
		let llmCalls = 0;
		const usersPerCall: string[][] = [];
		const reply = (ctx: { messages: { role: string; content?: unknown }[] }) => {
			llmCalls++;
			usersPerCall.push(
				ctx.messages
					.filter((m) => m.role === "user")
					.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))),
			);
			return scriptedAssistantMessage(`r${llmCalls}`);
		};
		const scripted = createScriptedStream({
			// One response per expected LLM turn (queue is consumed FIFO).
			responses: [reply, reply],
		});

		const agent = new Agent({
			streamFn: scripted.streamFn,
			initialState: { model: scripted.model },
			steeringMode: "one-at-a-time",
		});

		// Pre-queue two steers: initial poll drains s1 (injected before first assistant);
		// after first assistant, drain s2 for a second turn.
		agent.steer({ role: "user", content: "s1", timestamp: 1 });
		agent.steer({ role: "user", content: "s2", timestamp: 2 });

		await agent.prompt("p");

		expect(llmCalls).toBe(2);
		// First call: prompt + s1 only
		expect(usersPerCall[0]?.some((u) => u.includes("p") || u === "p")).toBe(true);
		expect(usersPerCall[0]).toContain("s1");
		expect(usersPerCall[0]).not.toContain("s2");
		// Second call: also has s2
		expect(usersPerCall[1]).toContain("s2");
		expect(agent.hasQueuedMessages()).toBe(false);
	});

	it("all mode drains every steering message at one drain point", async () => {
		let llmCalls = 0;
		const seenUserCounts: number[] = [];
		const scripted = createScriptedStream({
			responses: [
				(ctx) => {
					llmCalls++;
					seenUserCounts.push(ctx.messages.filter((m) => m.role === "user").length);
					return scriptedAssistantMessage(`r${llmCalls}`);
				},
			],
		});

		const agent = new Agent({
			streamFn: scripted.streamFn,
			initialState: { model: scripted.model },
			steeringMode: "all",
		});

		agent.steer({ role: "user", content: "s1", timestamp: 1 });
		agent.steer({ role: "user", content: "s2", timestamp: 2 });

		await agent.prompt("p");

		// Initial drain takes both steers before first assistant → only 1 LLM call after prompt.
		expect(llmCalls).toBe(1);
		// Context for that call: prompt + s1 + s2
		expect(seenUserCounts[0]).toBe(3);
		expect(agent.hasQueuedMessages()).toBe(false);
	});

	it("followUp one-at-a-time vs all modes", async () => {
		// one-at-a-time: each follow-up triggers its own outer-loop turn pair
		{
			let llmCalls = 0;
			const reply = () => {
				llmCalls++;
				return scriptedAssistantMessage(`o${llmCalls}`);
			};
			const scripted = createScriptedStream({
				responses: [reply, reply, reply],
			});
			const agent = new Agent({
				streamFn: scripted.streamFn,
				initialState: { model: scripted.model },
				followUpMode: "one-at-a-time",
			});
			agent.followUp({ role: "user", content: "f1", timestamp: 1 });
			agent.followUp({ role: "user", content: "f2", timestamp: 2 });
			await agent.prompt("p");
			// prompt assistant, then f1, then f2
			expect(llmCalls).toBe(3);
		}

		// all: both follow-ups inject together before one assistant turn
		{
			let llmCalls = 0;
			const seenUsers: number[] = [];
			const reply = (ctx: { messages: { role: string }[] }) => {
				llmCalls++;
				seenUsers.push(ctx.messages.filter((m) => m.role === "user").length);
				return scriptedAssistantMessage(`a${llmCalls}`);
			};
			const scripted = createScriptedStream({
				responses: [reply, reply],
			});
			const agent = new Agent({
				streamFn: scripted.streamFn,
				initialState: { model: scripted.model },
				followUpMode: "all",
			});
			agent.followUp({ role: "user", content: "f1", timestamp: 1 });
			agent.followUp({ role: "user", content: "f2", timestamp: 2 });
			await agent.prompt("p");
			// After natural stop, both follow-ups drain at once → 2 LLM calls total
			expect(llmCalls).toBe(2);
			// Second call sees prompt + f1 + f2
			expect(seenUsers[1]).toBe(3);
		}
	});

	it("steer does not skip pending tools", async () => {
		const executed: string[] = [];
		const toolStarted = createDeferred();
		const releaseTools = createDeferred();
		const tool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "echo",
			parameters: z.object({ value: z.string() }),
			async execute(_id, params) {
				toolStarted.resolve();
				await releaseTools.promise;
				executed.push((params as { value: string }).value);
				return {
					content: [{ type: "text", text: "ok" }],
					details: {},
				};
			},
		};

		const scripted = createScriptedStream({
			responses: [
				scriptedAssistantMessage(
					[
						scriptedToolCall("echo", { value: "a" }, { id: "a" }),
						scriptedToolCall("echo", { value: "b" }, { id: "b" }),
					],
					{ stopReason: "toolUse" },
				),
				scriptedAssistantMessage("done"),
			],
		});

		const agent = new Agent({
			streamFn: scripted.streamFn,
			initialState: { model: scripted.model, tools: [tool] },
			toolExecution: "sequential",
		});

		const run = agent.prompt("go");
		await toolStarted.promise;
		// Steer while tools are in flight — both tools must still complete before injection.
		agent.steer({ role: "user", content: "nudge", timestamp: 1 });
		releaseTools.resolve();
		await run;

		expect(executed).toEqual(["a", "b"]);
		const roles = agent.state.messages.map((m) => m.role);
		// tools complete fully, then steer injects before next assistant
		expect(roles).toEqual(["user", "assistant", "toolResult", "toolResult", "user", "assistant"]);
	});

	it("continue() from assistant tail drains one-at-a-time steering", async () => {
		let responseCount = 0;
		const reply = () => {
			responseCount++;
			return scriptedAssistantMessage(`Processed ${responseCount}`);
		};
		const scripted = createScriptedStream({
			responses: [reply, reply],
		});

		const agent = new Agent({
			streamFn: scripted.streamFn,
			initialState: {
				model: scripted.model,
				messages: [
					{ role: "user", content: "Initial", timestamp: 1 },
					scriptedAssistantMessage("Initial response"),
				],
			},
		});

		agent.steer({ role: "user", content: "Steering 1", timestamp: 2 });
		agent.steer({ role: "user", content: "Steering 2", timestamp: 3 });

		await agent.continue();

		// one-at-a-time: continue drains first as prompt (skipInitial), second after first assistant
		expect(responseCount).toBe(2);
		const recent = agent.state.messages.slice(-4);
		expect(recent.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
	});

	it("continue() from assistant tail processes follow-up when no steering", async () => {
		const scripted = createScriptedStream({
			responses: [scriptedAssistantMessage("Processed")],
		});
		const agent = new Agent({
			streamFn: scripted.streamFn,
			initialState: {
				model: scripted.model,
				messages: [
					{ role: "user", content: "Initial", timestamp: 1 },
					scriptedAssistantMessage("Initial response"),
				],
			},
		});

		agent.followUp({ role: "user", content: "Queued follow-up", timestamp: 2 });
		await agent.continue();

		const hasFollowUp = agent.state.messages.some(
			(m) => m.role === "user" && (m.content === "Queued follow-up" || JSON.stringify(m.content).includes("Queued")),
		);
		expect(hasFollowUp).toBe(true);
		expect(agent.state.messages[agent.state.messages.length - 1]?.role).toBe("assistant");
	});

	it("prepares follow-up messages at the queue boundary", async () => {
		const scripted = createScriptedStream({ responses: [scriptedAssistantMessage("Processed")] });
		const prepared: Array<{ kind: string; text: string }> = [];
		const agent = new Agent({
			streamFn: scripted.streamFn,
			prepareQueuedMessages: (messages, kind) => {
				for (const message of messages) {
					prepared.push({ kind, text: typeof message.content === "string" ? message.content : "" });
				}
				return messages;
			},
			initialState: {
				model: scripted.model,
				messages: [
					{ role: "user", content: "Initial", timestamp: 1 },
					scriptedAssistantMessage("Initial response"),
				],
			},
		});

		agent.followUp({ role: "user", content: "Queued follow-up", timestamp: 2 });
		await agent.continue();

		expect(prepared).toEqual([{ kind: "follow-up", text: "Queued follow-up" }]);
	});

	it("reset clears queues", () => {
		const scripted = createScriptedStream();
		const agent = new Agent({ streamFn: scripted.streamFn, initialState: { model: scripted.model } });
		agent.steer({ role: "user", content: "s", timestamp: 1 });
		agent.followUp({ role: "user", content: "f", timestamp: 2 });
		agent.reset();
		expect(agent.hasQueuedMessages()).toBe(false);
		expect(agent.state.messages).toEqual([]);
	});

	it("steeringMode / followUpMode setters update drain behavior", () => {
		const scripted = createScriptedStream();
		const agent = new Agent({ streamFn: scripted.streamFn, initialState: { model: scripted.model } });
		expect(agent.steeringMode).toBe("one-at-a-time");
		agent.steeringMode = "all";
		expect(agent.steeringMode).toBe("all");
		agent.followUpMode = "all";
		expect(agent.followUpMode).toBe("all");
	});

	it("keeps legacy prepareNextTurn signal callback behavior", async () => {
		const schema = z.object({});
		const tool: AgentTool<typeof schema> = {
			name: "noop",
			label: "Noop",
			description: "Noop tool",
			parameters: schema,
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};
		let requestCount = 0;
		let sawAbortSignal = false;
		const scripted = createScriptedStream({
			responses: [
				() => {
					requestCount++;
					return scriptedAssistantMessage([scriptedToolCall("noop", {}, { id: "tool-1" })], {
						stopReason: "toolUse",
					});
				},
				() => {
					requestCount++;
					return scriptedAssistantMessage("done");
				},
			],
		});
		const agent = new Agent({
			streamFn: scripted.streamFn,
			initialState: { model: scripted.model, tools: [tool] },
			prepareNextTurn: async (signal) => {
				sawAbortSignal = signal instanceof AbortSignal;
				return undefined;
			},
		});

		await agent.prompt("start");

		expect(requestCount).toBe(2);
		expect(sawAbortSignal).toBe(true);
	});

	it("prefers prepareNextTurnWithContext over legacy prepareNextTurn", async () => {
		const schema = z.object({});
		const tool: AgentTool<typeof schema> = {
			name: "noop",
			label: "Noop",
			description: "Noop tool",
			parameters: schema,
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};
		let usedWithContext = false;
		let usedLegacy = false;
		const scripted = createScriptedStream({
			responses: [
				scriptedAssistantMessage([scriptedToolCall("noop", {}, { id: "tool-1" })], { stopReason: "toolUse" }),
				scriptedAssistantMessage("done"),
			],
		});
		const agent = new Agent({
			streamFn: scripted.streamFn,
			initialState: { model: scripted.model, tools: [tool] },
			prepareNextTurn: async () => {
				usedLegacy = true;
				return undefined;
			},
			prepareNextTurnWithContext: async (context) => {
				usedWithContext = context.message.role === "assistant";
				return undefined;
			},
		});

		await agent.prompt("start");

		expect(usedWithContext).toBe(true);
		expect(usedLegacy).toBe(false);
	});

	it("forwards shouldStopAfterTurn through AgentOptions", async () => {
		const schema = z.object({});
		const tool: AgentTool<typeof schema> = {
			name: "noop",
			label: "Noop",
			description: "Noop tool",
			parameters: schema,
			execute: async () => ({ content: [{ type: "text", text: "tool complete" }], details: {} }),
		};
		let requestCount = 0;
		let sawAbortSignal = false;
		let callbackContextRoles: string[] = [];
		const scripted = createScriptedStream({
			responses: [
				() => {
					requestCount++;
					return scriptedAssistantMessage([scriptedToolCall("noop", {}, { id: "tool-1" })], {
						stopReason: "toolUse",
					});
				},
				() => {
					requestCount++;
					return scriptedAssistantMessage("should not run");
				},
			],
		});
		const agent = new Agent({
			streamFn: scripted.streamFn,
			initialState: { model: scripted.model, tools: [tool] },
			shouldStopAfterTurn: (context, signal) => {
				sawAbortSignal = signal instanceof AbortSignal;
				callbackContextRoles = context.context.messages.map((message) =>
					"role" in message ? String(message.role) : "?",
				);
				return true;
			},
		});

		await agent.prompt("start");

		expect(requestCount).toBe(1);
		expect(sawAbortSignal).toBe(true);
		expect(callbackContextRoles).toEqual(["user", "assistant", "toolResult"]);
	});

	it("maps thinkingLevel off to omitted StreamFn reasoning", async () => {
		let capturedReasoning: unknown = "unset";
		const scripted = createScriptedStream({
			responses: [scriptedAssistantMessage("ok")],
		});
		const wrapped = ((model, ctx, options) => {
			capturedReasoning = options?.reasoning;
			return scripted.streamFn(model, ctx, options);
		}) satisfies typeof scripted.streamFn;
		const agent = new Agent({
			streamFn: wrapped,
			initialState: { model: scripted.model },
		});
		await agent.prompt("hi");
		expect(agent.state.thinkingLevel).toBe("off");
		expect(capturedReasoning).toBeUndefined();
	});

	it("does not emit a second agent_end when a listener throws on agent_end", async () => {
		const scripted = createScriptedStream({
			responses: [scriptedAssistantMessage("ok")],
		});
		const agent = new Agent({
			streamFn: scripted.streamFn,
			initialState: { model: scripted.model },
		});
		const types: AgentEvent["type"][] = [];
		agent.subscribe((event) => {
			types.push(event.type);
			if (event.type === "agent_end") {
				throw new Error("listener failed");
			}
		});

		await agent.prompt("hi");

		expect(types.filter((t) => t === "agent_end")).toHaveLength(1);
		expect(agent.state.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
		expect(agent.state.errorMessage).toContain("listener failed");
	});

	it("forwards samplingParams to StreamFn", async () => {
		let captured: unknown = "unset";
		const scripted = createScriptedStream({
			responses: [scriptedAssistantMessage("ok")],
		});
		const wrapped = ((model, ctx, options) => {
			captured = options?.samplingParams;
			return scripted.streamFn(model, ctx, options);
		}) satisfies typeof scripted.streamFn;
		const agent = new Agent({
			streamFn: wrapped,
			initialState: { model: scripted.model },
			samplingParams: { top_p: 0.5 },
		});
		await agent.prompt("hi");
		expect(captured).toEqual({ top_p: 0.5 });
	});

	it("forwards non-off thinkingLevel as StreamFn reasoning", async () => {
		let capturedReasoning: unknown = "unset";
		const scripted = createScriptedStream({
			responses: [scriptedAssistantMessage("ok")],
		});
		const wrapped = ((model, ctx, options) => {
			capturedReasoning = options?.reasoning;
			return scripted.streamFn(model, ctx, options);
		}) satisfies typeof scripted.streamFn;
		const agent = new Agent({
			streamFn: wrapped,
			initialState: { model: scripted.model, thinkingLevel: "high" },
		});
		await agent.prompt("hi");
		expect(capturedReasoning).toBe("high");
	});
});
