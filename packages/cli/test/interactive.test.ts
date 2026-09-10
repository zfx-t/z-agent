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

	it("restores a checkpoint through the second picker and clears the transcript", async () => {
		const prompts = ["/sessions", "/exit"];
		let promptIndex = 0;
		const picks = [0, 1];
		let pickIndex = 0;
		const pickTitles: string[] = [];
		const lines: string[] = [];
		const reset = vi.fn();
		const agent = {
			prompt: vi.fn(),
			subscribe: () => () => {},
			reset,
			state: { messages: [] as unknown[] },
		} as unknown as Agent;
		const tui = {
			start: vi.fn(),
			close: vi.fn(),
			appendLine: (line: string) => {
				lines.push(line);
			},
			appendNotice: vi.fn(),
			clearTranscript: vi.fn(),
			readPrompt: async () => prompts[promptIndex++] ?? null,
			pickFromList: async (title: string) => {
				pickTitles.push(title);
				return picks[pickIndex++] ?? -1;
			},
		} as unknown as InteractiveTui;

		await runInteractive({
			agent,
			tui,
			listSessions: async () => ["sess-1"],
			onInspectSession: async () => ({
				ok: true,
				checkpoints: [
					{ id: "n1", label: "user: a", depth: 0, onLivePath: true, isLeaf: false },
					{ id: "n2", label: "user: b", depth: 1, onLivePath: true, isLeaf: true },
				],
			}),
			onRestoreCheckpoint: async (sessionId, nodeId) => {
				expect(sessionId).toBe("sess-1");
				expect(nodeId).toBe("n2");
				return [{ role: "user", content: [{ type: "text", text: "b" }], timestamp: 1 }];
			},
		});

		expect(pickTitles).toEqual(["Resume session", "Restore checkpoint"]);
		expect(reset).toHaveBeenCalledOnce();
		expect(agent.state.messages).toEqual([{ role: "user", content: [{ type: "text", text: "b" }], timestamp: 1 }]);
		expect(tui.clearTranscript).toHaveBeenCalledOnce();
		expect(lines.some((line) => line.includes("restored sess-1") && line.includes("user: b"))).toBe(true);
		expect(agent.prompt).not.toHaveBeenCalled();
	});

	it("refuses a malformed session without resetting the agent", async () => {
		const prompts = ["/sessions", "/exit"];
		let promptIndex = 0;
		const reset = vi.fn();
		const notices: Array<[string, string]> = [];
		const agent = {
			prompt: vi.fn(),
			subscribe: () => () => {},
			reset,
			state: { messages: [{ keep: true }] },
		} as unknown as Agent;
		const tui = {
			start: vi.fn(),
			close: vi.fn(),
			appendLine: vi.fn(),
			appendNotice: (kind: string, message: string) => {
				notices.push([kind, message]);
			},
			clearTranscript: vi.fn(),
			readPrompt: async () => prompts[promptIndex++] ?? null,
			pickFromList: async () => 0,
		} as unknown as InteractiveTui;
		const restore = vi.fn();

		await runInteractive({
			agent,
			tui,
			listSessions: async () => ["broken"],
			onInspectSession: async () => ({ ok: false, reason: "cycle", detail: "n1" }),
			onRestoreCheckpoint: restore,
		});

		expect(notices).toEqual([["error", "[sessions] malformed session (cycle): n1"]]);
		expect(restore).not.toHaveBeenCalled();
		expect(reset).not.toHaveBeenCalled();
		expect(tui.clearTranscript).not.toHaveBeenCalled();
	});

	it("cancels checkpoint restore without loading a session", async () => {
		const prompts = ["/sessions", "/exit"];
		let promptIndex = 0;
		const picks = [0, -1];
		let pickIndex = 0;
		const reset = vi.fn();
		const restore = vi.fn();
		const agent = {
			prompt: vi.fn(),
			subscribe: () => () => {},
			reset,
			state: {},
		} as unknown as Agent;
		const tui = {
			start: vi.fn(),
			close: vi.fn(),
			appendLine: vi.fn(),
			appendNotice: vi.fn(),
			clearTranscript: vi.fn(),
			readPrompt: async () => prompts[promptIndex++] ?? null,
			pickFromList: async () => picks[pickIndex++] ?? -1,
		} as unknown as InteractiveTui;

		await runInteractive({
			agent,
			tui,
			listSessions: async () => ["sess-1"],
			onInspectSession: async () => ({
				ok: true,
				checkpoints: [{ id: "n1", label: "user: a", depth: 0, onLivePath: true, isLeaf: true }],
			}),
			onRestoreCheckpoint: restore,
		});

		expect(restore).not.toHaveBeenCalled();
		expect(reset).not.toHaveBeenCalled();
	});
});
