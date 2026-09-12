import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@z-agent/agent";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	emptyUsage,
	type Model,
	type StreamFn,
} from "@z-agent/ai";
import { describe, expect, it } from "vitest";
import { streamOpId } from "../src/op-id.ts";
import { OpIntentMismatchError, OpInterruptedError, withSandwich } from "../src/sandwich.ts";
import { JsonlOpStore, type OpStore } from "../src/store.ts";
import { SqliteOpStore } from "../src/store-sqlite.ts";
import { wrapStreamFn, wrapTools } from "../src/wrap.ts";

interface StoreHandle {
	store: OpStore;
	close(): void;
}

const backends: [string, () => Promise<StoreHandle>][] = [
	[
		"jsonl",
		async () => ({ store: new JsonlOpStore(await mkdtemp(join(tmpdir(), "z-harness-jsonl-"))), close: () => {} }),
	],
	[
		"sqlite",
		async () => {
			const store = new SqliteOpStore(await mkdtemp(join(tmpdir(), "z-harness-sqlite-")));
			return { store, close: () => store.close() };
		},
	],
];

/** OpStore wrapper that records every committed phase, in order. */
function recording(store: OpStore): { store: OpStore; phases: string[] } {
	const phases: string[] = [];
	return {
		phases,
		store: {
			load: (opId) => store.load(opId),
			commit: async (state) => {
				phases.push(state.phase);
				await store.commit(state);
			},
			delete: (opId) => store.delete(opId),
		},
	};
}

function assistant(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "test",
		model: "m1",
		usage: emptyUsage(),
		stopReason,
		errorMessage: stopReason === "error" || stopReason === "aborted" ? `reason: ${stopReason}` : undefined,
		timestamp: 1,
	};
}

const model: Model = { id: "m1", name: "M1", api: "test", provider: "test", baseUrl: "http://x" };

function ctx(...texts: string[]): Context {
	return { messages: texts.map((t) => ({ role: "user", content: t, timestamp: 1 })) };
}

/** Scripted StreamFn: emits start, one text_delta, done, end. */
function scriptedStreamFn(message: AssistantMessage, onCall?: () => void): StreamFn & { calls: number } {
	const fn: StreamFn & { calls: number } = (_model, _context, _options) => {
		fn.calls += 1;
		onCall?.();
		const stream = createAssistantMessageEventStream();
		const text = message.content[0]?.type === "text" ? message.content[0].text : "";
		stream.push({ type: "start", partial: { ...message, content: [] } });
		if (text) {
			stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
		}
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			stream.push({ type: "error", reason: message.stopReason, error: message });
		} else {
			stream.push({
				type: "done",
				reason: message.stopReason as "stop" | "length" | "toolUse",
				message,
			});
		}
		stream.end(message);
		return stream;
	};
	fn.calls = 0;
	return fn;
}

async function collect(
	stream: AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of await stream) {
		events.push(event);
	}
	return events;
}

for (const [backend, makeStore] of backends) {
	describe(`L5 sandwich (${backend})`, () => {
		it("commits intent → effect → settle → done in order", async () => {
			const { store, close } = await makeStore();
			const rec = recording(store);
			await withSandwich({
				store: rec.store,
				opId: "tool:p1",
				kind: "tool",
				intent: { name: "write" },
				effect: async () => "r",
				onInterrupted: () => "interrupted",
				policy: "fail",
			});
			expect(rec.phases).toEqual(["intent", "effect", "settle", "done"]);
			const state = await store.load("tool:p1");
			expect(state).toMatchObject({ phase: "done", attempt: 1 });
			expect(state?.createdAt).toBeTypeOf("number");
			expect(state?.intentHash).toMatch(/^[0-9a-f]{64}$/);
			close();
		});

		it("does not re-run a settled effect after crash/resume", async () => {
			const { store, close } = await makeStore();
			let runs = 0;
			const effect = async () => ({ ok: true, n: ++runs });
			const first = await withSandwich({
				store,
				opId: "tool:call-1",
				kind: "tool",
				intent: { name: "write" },
				effect,
				onInterrupted: () => ({ ok: false, n: -1 }),
				policy: "fail",
			});
			expect(first).toEqual({ ok: true, n: 1 });

			const resumed = await withSandwich({
				store,
				opId: "tool:call-1",
				kind: "tool",
				intent: { name: "write" },
				effect,
				onInterrupted: () => ({ ok: false, n: -1 }),
				policy: "fail",
			});
			expect(resumed).toEqual({ ok: true, n: 1 });
			expect(runs).toBe(1);
			close();
		});

		it("re-runs with attempt 2 when only intent was committed", async () => {
			const { store, close } = await makeStore();
			await store.commit({
				opId: "tool:call-2",
				kind: "tool",
				phase: "intent",
				intent: { name: "bash" },
				attempt: 1,
				createdAt: 1,
				updatedAt: 1,
			});
			let runs = 0;
			const result = await withSandwich({
				store,
				opId: "tool:call-2",
				kind: "tool",
				intent: { name: "bash" },
				effect: async () => `fresh-${++runs}`,
				onInterrupted: () => "interrupted",
				policy: "fail",
			});
			expect(result).toBe("fresh-1");
			expect(await store.load("tool:call-2")).toMatchObject({ phase: "done", attempt: 2, createdAt: 1 });
			close();
		});

		it("fail policy turns an effect-phase op into the interruption result without running", async () => {
			const { store, close } = await makeStore();
			await store.commit({
				opId: "tool:call-3",
				kind: "tool",
				phase: "effect",
				intent: { name: "bash" },
				attempt: 1,
				createdAt: 1,
				updatedAt: 1,
			});
			let runs = 0;
			const result = await withSandwich({
				store,
				opId: "tool:call-3",
				kind: "tool",
				intent: { name: "bash" },
				effect: async () => `ran-${++runs}`,
				onInterrupted: () => "interrupted-result",
				policy: "fail",
			});
			expect(result).toBe("interrupted-result");
			expect(runs).toBe(0);
			expect(await store.load("tool:call-3")).toMatchObject({ phase: "done", result: "interrupted-result" });
			close();
		});

		it("rerun policy re-executes an effect-phase op with attempt 2", async () => {
			const { store, close } = await makeStore();
			await store.commit({
				opId: "stream:s:1",
				kind: "stream",
				phase: "effect",
				intent: { model: "m" },
				attempt: 1,
				createdAt: 5,
				updatedAt: 5,
			});
			let runs = 0;
			const result = await withSandwich({
				store,
				opId: "stream:s:1",
				kind: "stream",
				intent: { model: "m" },
				effect: async () => `re-${++runs}`,
				onInterrupted: () => "interrupted",
				policy: "rerun",
			});
			expect(result).toBe("re-1");
			expect(await store.load("stream:s:1")).toMatchObject({ phase: "done", attempt: 2 });
			close();
		});

		it("throws OpIntentMismatchError when the same opId has different inputs", async () => {
			const { store, close } = await makeStore();
			await withSandwich({
				store,
				opId: "tool:same",
				kind: "tool",
				intent: { name: "write", params: { path: "a" } },
				effect: async () => 1,
				onInterrupted: () => 0,
				policy: "fail",
			});
			await expect(
				withSandwich({
					store,
					opId: "tool:same",
					kind: "tool",
					intent: { name: "write", params: { path: "b" } },
					effect: async () => 2,
					onInterrupted: () => 0,
					policy: "fail",
				}),
			).rejects.toBeInstanceOf(OpIntentMismatchError);
			close();
		});

		it("wrapTools replays a settled toolCallId and throws on interrupt under fail", async () => {
			const { store, close } = await makeStore();
			let runs = 0;
			const tool = {
				name: "echo",
				description: "echo",
				parameters: { parse: (value: unknown) => value },
				async execute() {
					runs += 1;
					return { content: [{ type: "text", text: "ok" }], details: {} };
				},
			} as unknown as AgentTool;
			const [wrapped] = wrapTools([tool], store);
			await wrapped.execute("c1", {});
			await wrapped.execute("c1", {});
			expect(runs).toBe(1);

			await store.commit({
				opId: "tool:c2",
				kind: "tool",
				phase: "effect",
				intent: { name: "echo", params: {} },
				attempt: 1,
				createdAt: 1,
				updatedAt: 1,
			});
			await expect(wrapped.execute("c2", {})).rejects.toBeInstanceOf(OpInterruptedError);
			expect(runs).toBe(1);
			close();
		});

		it("wrapTools re-executes an interrupted op under rerun", async () => {
			const { store, close } = await makeStore();
			let runs = 0;
			const tool = {
				name: "echo",
				description: "echo",
				parameters: { parse: (v: unknown) => v },
				async execute() {
					runs += 1;
					return { content: [{ type: "text", text: `run-${runs}` }], details: {} };
				},
			} as unknown as AgentTool;
			const [wrapped] = wrapTools([tool], store, { resume: { interruptedTool: "rerun" } });
			await store.commit({
				opId: "tool:c3",
				kind: "tool",
				phase: "effect",
				intent: { name: "echo", params: {} },
				attempt: 1,
				createdAt: 1,
				updatedAt: 1,
			});
			const result = await wrapped.execute("c3", {});
			expect(result.content[0]).toMatchObject({ text: "run-1" });
			expect(runs).toBe(1);
			close();
		});

		it("wrapStreamFn tees a live stream and replays it on a second call", async () => {
			const { store, close } = await makeStore();
			const final = assistant("hello world");
			const inner = scriptedStreamFn(final);
			const wrapped = wrapStreamFn(inner, store);

			const liveEvents = await collect(wrapped(model, ctx("hi")));
			expect(liveEvents.map((e) => e.type)).toEqual(["start", "text_delta", "done"]);
			expect(inner.calls).toBe(1);

			// Second call with the same context replays without invoking inner.
			const replayed = await collect(wrapped(model, ctx("hi")));
			expect(replayed.map((e) => e.type)).toEqual(["start", "done"]);
			expect(inner.calls).toBe(1);
			const done = replayed.find((e) => e.type === "done");
			expect(done && done.type === "done" ? done.message : undefined).toEqual(final);
			close();
		});

		it("wrapStreamFn maps equal-length different contexts to distinct ops", async () => {
			const { store, close } = await makeStore();
			const inner = scriptedStreamFn(assistant("x"));
			const wrapped = wrapStreamFn(inner, store);
			await collect(wrapped(model, ctx("aaa")));
			await collect(wrapped(model, ctx("bbb")));
			expect(inner.calls).toBe(2);
			close();
		});

		it("wrapStreamFn persists and replays an aborted result", async () => {
			const { store, close } = await makeStore();
			const inner = scriptedStreamFn(assistant("", "aborted"));
			const wrapped = wrapStreamFn(inner, store);
			const first = await collect(wrapped(model, ctx("hi")));
			expect(first.map((e) => e.type)).toEqual(["start", "error"]);
			const second = await collect(wrapped(model, ctx("hi")));
			expect(second.map((e) => e.type)).toEqual(["start", "error"]);
			expect(inner.calls).toBe(1);
			close();
		});

		it("wrapStreamFn emits a single start when the inner stream ends bare", async () => {
			const { store, close } = await makeStore();
			const partial = assistant("partial");
			const bareEnd = (): AssistantMessageEventStream => {
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "start", partial });
				stream.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial });
				stream.end(); // no terminal event — result() rejects
				return stream;
			};
			const events = await collect(wrapStreamFn(bareEnd, store)(model, ctx("hi")));
			expect(events.map((e) => e.type)).toEqual(["start", "text_delta", "error"]);
			const err = events.find((e) => e.type === "error");
			expect(err && err.type === "error" ? err.error.stopReason : "").toBe("error");
			close();
		});

		it("wrapStreamFn emits a single start when a settle commit fails mid-stream", async () => {
			const { store, close } = await makeStore();
			let commits = 0;
			const flaky: OpStore = {
				load: (opId) => store.load(opId),
				commit: async (state) => {
					commits += 1;
					if (commits >= 3) {
						throw new Error("disk full");
					}
					await store.commit(state);
				},
				delete: (opId) => store.delete(opId),
			};
			const inner = scriptedStreamFn(assistant("hello"));
			const events = await collect(wrapStreamFn(inner, flaky)(model, ctx("hi")));
			expect(events.map((e) => e.type)).toEqual(["start", "text_delta", "error"]);
			const err = events.find((e) => e.type === "error");
			expect(err && err.type === "error" ? err.error.errorMessage : "").toContain("disk full");
			close();
		});

		it("wrapStreamFn with interruptedStream: fail yields an error-encoded message", async () => {
			const { store, close } = await makeStore();
			const inner = scriptedStreamFn(assistant("nope"));
			const wrapped = wrapStreamFn(inner, store, { resume: { interruptedStream: "fail" } });
			// Pre-commit an effect-phase row for the op this call will compute.
			const { opId } = streamOpId({ modelId: model.id, api: model.api, context: ctx("hi") });
			await store.commit({
				opId,
				kind: "stream",
				phase: "effect",
				intent: { model: "m1" },
				attempt: 1,
				createdAt: 1,
				updatedAt: 1,
			});
			const events = await collect(wrapped(model, ctx("hi")));
			expect(events.map((e) => e.type)).toEqual(["start", "error"]);
			const err = events.find((e) => e.type === "error");
			expect(err && err.type === "error" ? err.error.errorMessage : "").toContain("interrupted");
			expect(inner.calls).toBe(0);
			close();
		});
	});
}
