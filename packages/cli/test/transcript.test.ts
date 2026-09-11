import type { AgentMessage } from "@z-agent/agent";
import { emptyUsage } from "@z-agent/ai";
import type { InteractiveTui } from "@z-agent/tui";
import { describe, expect, it, vi } from "vitest";
import { replayTranscript } from "../src/transcript.ts";

function mockTui() {
	return {
		appendUser: vi.fn(),
		appendAssistantDelta: vi.fn(),
		appendThinkingDelta: vi.fn(),
		appendToolStart: vi.fn(),
		appendToolEnd: vi.fn(),
		appendNotice: vi.fn(),
		appendLine: vi.fn(),
	} as unknown as InteractiveTui;
}

describe("replayTranscript", () => {
	it("replays user, assistant, thinking, and paired tool rows", () => {
		const tui = mockTui();
		const messages: AgentMessage[] = [
			{ role: "user", content: [{ type: "text", text: "list files" }], timestamp: 1 },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "hmm" },
					{ type: "text", text: "checking" },
					{ type: "toolCall", id: "c1", name: "ls", arguments: { path: "." } },
				],
				api: "test",
				provider: "test",
				model: "m",
				usage: emptyUsage(),
				stopReason: "toolUse",
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "c1",
				toolName: "ls",
				content: [{ type: "text", text: "a.ts" }],
				isError: false,
				timestamp: 3,
			},
		];
		replayTranscript(tui, messages);

		expect(tui.appendUser).toHaveBeenCalledWith("list files", false);
		expect(tui.appendThinkingDelta).toHaveBeenCalledWith("hmm");
		expect(tui.appendAssistantDelta).toHaveBeenCalledWith("checking");
		expect(tui.appendToolStart).toHaveBeenCalledWith("c1", "ls", { path: "." });
		expect(tui.appendToolEnd).toHaveBeenCalledWith("c1", "a.ts", false, undefined);
		expect(tui.appendNotice).not.toHaveBeenCalled();
	});

	it("closes dangling tool calls and synthesizes rows for orphan results", () => {
		const tui = mockTui();
		const messages: AgentMessage[] = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "x" } }],
				api: "test",
				provider: "test",
				model: "m",
				usage: emptyUsage(),
				stopReason: "toolUse",
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "orphan",
				toolName: "read",
				content: [{ type: "text", text: "body" }],
				isError: true,
				timestamp: 2,
			},
		];
		replayTranscript(tui, messages);

		expect(tui.appendToolStart).toHaveBeenCalledWith("c2", "bash", { command: "x" });
		expect(tui.appendToolStart).toHaveBeenCalledWith("orphan", "read", {});
		expect(tui.appendToolEnd).toHaveBeenCalledWith("orphan", "body", true, undefined);
		expect(tui.appendToolEnd).toHaveBeenCalledWith("c2", "(no result recorded)", true);
	});

	it("surfaces assistant errorMessage and string user content", () => {
		const tui = mockTui();
		replayTranscript(tui, [
			{ role: "user", content: "plain", timestamp: 1 },
			{
				role: "assistant",
				content: [],
				api: "test",
				provider: "test",
				model: "m",
				usage: emptyUsage(),
				stopReason: "error",
				errorMessage: "boom",
				timestamp: 2,
			},
		]);
		expect(tui.appendUser).toHaveBeenCalledWith("plain", false);
		expect(tui.appendNotice).toHaveBeenCalledWith("error", "boom");
	});
});
