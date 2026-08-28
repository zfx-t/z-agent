import type { Agent, AgentEvent } from "@z-agent/agent";
import type { InteractiveTui } from "@z-agent/tui";
import { describe, expect, it, vi } from "vitest";
import { runInteractive, submitTuiInputDuringRun, subscribeTui } from "../src/interactive.ts";

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

	it("handles /status and /model without a coordinator and never prompts the agent", async () => {
		const prompts = ["/status", "/model context 200000", "/exit"];
		let promptIndex = 0;
		const lines: string[] = [];
		const notices: Array<[string, string]> = [];
		const modelArgs: string[] = [];
		const prompt = vi.fn();
		const unsubscribe = vi.fn();
		const tui = {
			start: vi.fn(),
			close: vi.fn(),
			showStatus: vi.fn(),
			appendLine: (line: string) => {
				lines.push(line);
			},
			appendNotice: (kind: string, message: string) => {
				notices.push([kind, message]);
			},
			readPrompt: async () => prompts[promptIndex++] ?? null,
		} as unknown as InteractiveTui;
		const agent = {
			prompt,
			subscribe: () => unsubscribe,
			state: {},
		} as unknown as Agent;

		await runInteractive({
			agent,
			tui,
			formatStatus: () => "[status] wired",
			onModel: async (args) => {
				modelArgs.push(args);
			},
		});

		expect(tui.start).toHaveBeenCalledOnce();
		expect(tui.close).toHaveBeenCalledOnce();
		expect(unsubscribe).toHaveBeenCalledOnce();
		expect(lines).toContain("[status] wired");
		expect(modelArgs).toEqual(["context 200000"]);
		expect(prompt).not.toHaveBeenCalled();
		expect(tui.showStatus).not.toHaveBeenCalled();
		expect(notices).toEqual([]);
	});

	it("swallows coordinator-less /model when onModel is missing", async () => {
		const prompts = ["/model context 200000", "/exit"];
		let promptIndex = 0;
		const prompt = vi.fn();
		const tui = {
			start: vi.fn(),
			close: vi.fn(),
			showStatus: vi.fn(),
			appendLine: vi.fn(),
			appendNotice: vi.fn(),
			readPrompt: async () => prompts[promptIndex++] ?? null,
		} as unknown as InteractiveTui;
		const agent = {
			prompt,
			subscribe: () => () => {},
			state: {},
		} as unknown as Agent;

		await runInteractive({ agent, tui });

		expect(prompt).not.toHaveBeenCalled();
		expect(tui.close).toHaveBeenCalledOnce();
	});
});
