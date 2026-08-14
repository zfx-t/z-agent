import type { BeforeToolCallContext } from "@z-agent/agent";
import { describe, expect, it } from "vitest";
import { createConfirmGate } from "../src/confirm.ts";

function ctx(name: string): BeforeToolCallContext {
	return {
		assistantMessage: {
			role: "assistant",
			content: [],
			api: "t",
			provider: "t",
			model: "t",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1,
		},
		toolCall: { type: "toolCall", id: "1", name, arguments: {} },
		args: {},
		context: { systemPrompt: "", messages: [] },
	};
}

describe("createConfirmGate", () => {
	it("auto-allows read and autoYes mutating tools", async () => {
		const asked: string[] = [];
		const gate = createConfirmGate({
			autoYes: false,
			ask: async (name) => {
				asked.push(name);
				return "deny";
			},
		});
		expect(await gate(ctx("read"))).toBeUndefined();
		expect(asked).toEqual([]);
		const yes = createConfirmGate({ autoYes: true, ask: async () => "deny" });
		expect(await yes(ctx("write"))).toBeUndefined();
	});

	it("denies and always-allows mutating tools", async () => {
		const answers: Array<"once" | "always" | "deny"> = ["deny", "always", "once"];
		const gate = createConfirmGate({
			autoYes: false,
			ask: async () => answers.shift() ?? "once",
		});
		expect(await gate(ctx("bash"))).toEqual({ block: true, reason: "User denied bash" });
		expect(await gate(ctx("write"))).toBeUndefined();
		expect(await gate(ctx("write"))).toBeUndefined();
	});
});
