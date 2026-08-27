import type { Agent, AgentEvent } from "@z-agent/agent";
import type { InteractiveTui } from "@z-agent/tui";
import { describe, expect, it, vi } from "vitest";
import { submitTuiInputDuringRun, subscribeTui } from "../src/interactive.ts";

describe("interactive TUI adaptation", () => {
	it("maps one tool lifecycle onto one structured TUI entry", () => {
		let listener: ((event: AgentEvent, signal: AbortSignal) => Promise<void> | void) | undefined;
		const agent = {
			subscribe(next: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void) {
				listener = next;
				return () => {};
			},
		} as unknown as Agent;
		const tui = {
			setStreaming: vi.fn(),
			appendAssistantDelta: vi.fn(),
			appendThinkingDelta: vi.fn(),
			appendToolStart: vi.fn(),
			appendToolUpdate: vi.fn(),
			appendToolEnd: vi.fn(),
		} as unknown as InteractiveTui;
		subscribeTui(agent, tui);
		const signal = new AbortController().signal;

		listener?.({ type: "agent_start" }, signal);
		listener?.(
			{
				type: "tool_execution_start",
				toolCallId: "call-1",
				toolName: "read",
				args: { path: "a.ts" },
			},
			signal,
		);
		listener?.(
			{
				type: "tool_execution_update",
				toolCallId: "call-1",
				toolName: "read",
				args: { path: "a.ts" },
				partialResult: { content: [{ type: "text", text: "partial" }], details: { path: "a.ts" } },
			},
			signal,
		);
		listener?.(
			{
				type: "tool_execution_end",
				toolCallId: "call-1",
				toolName: "read",
				result: { content: [{ type: "text", text: "done" }], details: { path: "a.ts" } },
				isError: false,
			},
			signal,
		);

		expect(tui.appendToolStart).toHaveBeenCalledWith("call-1", "read", { path: "a.ts" });
		expect(tui.appendToolUpdate).toHaveBeenCalledWith("call-1", {
			outputText: "partial",
			detailsText: '{"path":"a.ts"}',
		});
		expect(tui.appendToolEnd).toHaveBeenCalledWith("call-1", "done", false, '{"path":"a.ts"}');
	});

	it("turns running input into a user message for the agent", () => {
		const steer = vi.fn();
		submitTuiInputDuringRun({ steer }, "preserve offsets");
		expect(steer).toHaveBeenCalledOnce();
		expect(steer.mock.calls[0]?.[0]).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "preserve offsets" }],
		});
	});
});
