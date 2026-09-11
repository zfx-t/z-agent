import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@z-agent/agent";
import { describe, expect, it } from "vitest";
import { withSandwich } from "../src/sandwich.ts";
import { SqliteOpStore } from "../src/store-sqlite.ts";
import { wrapTools } from "../src/wrap.ts";

describe("SqliteOpStore", () => {
	it("does not re-run a settled effect after crash/resume", async () => {
		const dir = await mkdtemp(join(tmpdir(), "z-harness-sqlite-"));
		const store = new SqliteOpStore(dir);
		let runs = 0;
		const first = await withSandwich(store, "tool:call-1", "tool", { name: "write" }, async () => {
			runs += 1;
			return { ok: true, n: runs };
		});
		expect(first).toEqual({ ok: true, n: 1 });
		expect(runs).toBe(1);

		const resumed = await withSandwich(store, "tool:call-1", "tool", { name: "write" }, async () => {
			runs += 1;
			return { ok: true, n: runs };
		});
		expect(resumed).toEqual({ ok: true, n: 1 });
		expect(runs).toBe(1);
		store.close();
	});

	it("re-runs when only intent was committed", async () => {
		const dir = await mkdtemp(join(tmpdir(), "z-harness-sqlite-"));
		const store = new SqliteOpStore(dir);
		await store.commit({
			opId: "tool:call-2",
			kind: "tool",
			phase: "intent",
			intent: { name: "bash" },
			updatedAt: Date.now(),
		});
		let runs = 0;
		const result = await withSandwich(store, "tool:call-2", "tool", { name: "bash" }, async () => {
			runs += 1;
			return "fresh";
		});
		expect(result).toBe("fresh");
		expect(runs).toBe(1);
		store.close();
	});

	it("wrapTools does not re-execute a settled toolCallId", async () => {
		const dir = await mkdtemp(join(tmpdir(), "z-harness-sqlite-wrap-"));
		const store = new SqliteOpStore(dir);
		let runs = 0;
		const tool = {
			name: "echo",
			description: "echo",
			parameters: { parse: (value: unknown) => value },
			async execute() {
				runs += 1;
				return { content: [{ type: "text", text: "ok" }] };
			},
		} as unknown as AgentTool;
		const [wrapped] = wrapTools([tool], store);
		await wrapped.execute("c1", {});
		await wrapped.execute("c1", {});
		expect(runs).toBe(1);
		store.close();
	});

	it("delete removes the stored op", async () => {
		const dir = await mkdtemp(join(tmpdir(), "z-harness-sqlite-"));
		const store = new SqliteOpStore(dir);
		await store.commit({
			opId: "stream:s1:3",
			kind: "stream",
			phase: "done",
			result: { text: "cached" },
			updatedAt: Date.now(),
		});
		expect(await store.load("stream:s1:3")).toMatchObject({ phase: "done" });
		await store.delete("stream:s1:3");
		expect(await store.load("stream:s1:3")).toBeUndefined();
		store.close();
	});

	it("persists op.state across close and reopen", async () => {
		const dir = await mkdtemp(join(tmpdir(), "z-harness-sqlite-"));
		const first = new SqliteOpStore(dir);
		await first.commit({
			opId: "tool:c9",
			kind: "tool",
			phase: "done",
			result: { n: 9 },
			updatedAt: Date.now(),
		});
		first.close();

		const reopened = new SqliteOpStore(dir);
		expect(await reopened.load<unknown, { n: number }>("tool:c9")).toMatchObject({
			opId: "tool:c9",
			phase: "done",
			result: { n: 9 },
		});
		reopened.close();
	});
});
