import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@z-agent/agent";
import { describe, expect, it } from "vitest";
import { withSandwich } from "../src/sandwich.ts";
import { JsonlOpStore } from "../src/store.ts";
import { wrapTools } from "../src/wrap.ts";

describe("L5 sandwich", () => {
	it("does not re-run a settled effect after crash/resume", async () => {
		const dir = await mkdtemp(join(tmpdir(), "z-harness-"));
		const store = new JsonlOpStore(dir);
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
	});

	it("re-runs when only intent was committed", async () => {
		const dir = await mkdtemp(join(tmpdir(), "z-harness-"));
		const store = new JsonlOpStore(dir);
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
	});

	it("wrapTools does not re-execute a settled toolCallId", async () => {
		const dir = await mkdtemp(join(tmpdir(), "z-harness-wrap-"));
		const store = new JsonlOpStore(dir);
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
	});
});
