import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
		const input = {
			store,
			opId: "tool:call-1",
			kind: "tool" as const,
			intent: { name: "write" },
			effect: async () => {
				runs += 1;
				return { ok: true, n: runs };
			},
			onInterrupted: () => ({ ok: false, n: -1 }),
			policy: "fail" as const,
		};
		const first = await withSandwich(input);
		expect(first).toEqual({ ok: true, n: 1 });
		expect(runs).toBe(1);

		const resumed = await withSandwich(input);
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
			attempt: 1,
			createdAt: 1,
			updatedAt: Date.now(),
		});
		let runs = 0;
		const result = await withSandwich({
			store,
			opId: "tool:call-2",
			kind: "tool",
			intent: { name: "bash" },
			effect: async () => {
				runs += 1;
				return "fresh";
			},
			onInterrupted: () => "interrupted",
			policy: "fail",
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
			attempt: 1,
			createdAt: 1,
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
			attempt: 1,
			createdAt: 123,
			updatedAt: Date.now(),
		});
		first.close();

		const reopened = new SqliteOpStore(dir);
		expect(await reopened.load<unknown, { n: number }>("tool:c9")).toMatchObject({
			opId: "tool:c9",
			phase: "done",
			result: { n: 9 },
			attempt: 1,
			createdAt: 123,
		});
		reopened.close();
	});

	it("round-trips intentHash, attempt, and createdAt", async () => {
		const dir = await mkdtemp(join(tmpdir(), "z-harness-sqlite-"));
		const store = new SqliteOpStore(dir);
		await store.commit({
			opId: "tool:h1",
			kind: "tool",
			phase: "settle",
			intent: { name: "bash" },
			intentHash: "abc123",
			result: { ok: true },
			attempt: 2,
			createdAt: 1000,
			updatedAt: 2000,
		});
		const loaded = await store.load("tool:h1");
		expect(loaded).toMatchObject({ intentHash: "abc123", attempt: 2, createdAt: 1000 });
		expect(loaded?.updatedAt).toBeGreaterThan(2000);
		store.close();
	});

	it("migrates a pre-ADR-0030 database on open", async () => {
		const dir = await mkdtemp(join(tmpdir(), "z-harness-sqlite-"));
		const dbPath = join(dir, "op.state.db");
		const legacy = new DatabaseSync(dbPath);
		legacy.exec(`
			CREATE TABLE op_state (
				op_id TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				phase TEXT NOT NULL,
				intent TEXT,
				result TEXT,
				updated_at INTEGER NOT NULL
			)
		`);
		legacy
			.prepare("INSERT INTO op_state (op_id, kind, phase, intent, result, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
			.run("tool:legacy", "tool", "done", JSON.stringify({ name: "ls" }), JSON.stringify({ ok: 1 }), 42);
		legacy.close();

		const store = new SqliteOpStore(dir);
		const row = await store.load("tool:legacy");
		expect(row).toMatchObject({ phase: "done", attempt: 1, createdAt: 42, intentHash: undefined });
		await store.commit({ ...row!, phase: "done", updatedAt: Date.now() });
		expect(await store.load("tool:legacy")).toMatchObject({ phase: "done", attempt: 1 });
		store.close();
	});
});
