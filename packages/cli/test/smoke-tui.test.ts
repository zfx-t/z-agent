import type { AgentTool } from "@z-agent/agent";
import { Agent } from "@z-agent/agent";
import type { AssistantMessage, Model, StreamFn } from "@z-agent/ai";
import { createAssistantMessageEventStream, emptyUsage } from "@z-agent/ai";
import { InteractiveTui } from "@z-agent/tui";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createConfirmGate } from "../src/confirm.ts";
import { runInteractive } from "../src/interactive.ts";

const TEST_MODEL: Model = {
	id: "test-1",
	name: "Test",
	api: "test",
	provider: "test",
	baseUrl: "http://localhost:0",
	input: ["text"],
};

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "test",
		provider: "test",
		model: "test-1",
		usage: emptyUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function queuedStream(responses: Array<AssistantMessage | (() => Promise<AssistantMessage>)>): StreamFn {
	const pending = [...responses];
	return () => {
		const stream = createAssistantMessageEventStream();
		void (async () => {
			const next = pending.shift();
			const message =
				next === undefined ? assistantMessage([], "error") : typeof next === "function" ? await next() : next;
			stream.push({
				type: "start",
				partial: { ...message, content: message.content.slice(), stopReason: "pending" },
			});
			for (const [index, block] of message.content.entries()) {
				if (block.type === "text") {
					stream.push({
						type: "text_delta",
						contentIndex: index,
						delta: block.text,
						partial: message,
					});
				} else if (block.type === "toolCall") {
					stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: message });
				}
			}
			stream.push({
				type: "done",
				reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
				message,
			});
			stream.end(message);
		})();
		return stream;
	};
}

function fakeIo(columns = 80, rows = 24) {
	const writes: string[] = [];
	const stdin = {
		isTTY: true,
		on() {},
		off() {},
		pause() {},
		setRawMode() {},
	} as unknown as NodeJS.ReadStream;
	const stdout = {
		isTTY: true,
		columns,
		rows,
		write(chunk: string) {
			writes.push(chunk);
			return true;
		},
		on() {},
		off() {},
	} as unknown as NodeJS.WriteStream;
	return { stdin, stdout, writes };
}

function pingTool(): AgentTool {
	return {
		name: "ping",
		label: "ping",
		description: "ping",
		parameters: z.object({}),
		async execute() {
			return { content: [{ type: "text", text: "pong" }], details: {} };
		},
	};
}

const ESC = String.fromCharCode(27);

function strip(writes: string[]): string {
	return writes.join("").split(ESC).join("");
}

/** Split LineScreen output into painted rows and return their visible text. */
function paintedRows(writes: string[]): string[] {
	const rows: string[] = [];
	for (const chunk of writes) {
		for (const part of chunk.split(`${ESC}[`)) {
			const row = part.replace(/^\d+;1H/u, "").replace(/^2K/u, "");
			if (/^\?\d+[hl]/u.test(row) || /^[\d;]*m$/u.test(row) || row.length === 0) {
				continue;
			}
			rows.push(row.replace(/[\d;]*m/gu, ""));
		}
	}
	return rows;
}

describe("scripted TUI smoke", () => {
	it("streams a tool lifecycle into one structured entry at 80x24", async () => {
		const io = fakeIo();
		const streamFn = queuedStream([
			assistantMessage([{ type: "toolCall", id: "c1", name: "ping", arguments: {} }], "toolUse"),
			assistantMessage([{ type: "text", text: "done" }]),
		]);
		const tui = new InteractiveTui({ ...io, columns: 80, rows: 24 });
		const agent = new Agent({
			streamFn,
			initialState: { model: TEST_MODEL, tools: [pingTool()] },
		});
		const running = runInteractive({ agent, tui, hasModel: true });
		tui.pushKey({ type: "char", value: "go" });
		tui.pushKey({ type: "enter" });
		await new Promise((resolve) => setTimeout(resolve, 40));
		tui.pushKey({ type: "char", value: "/exit" });
		tui.pushKey({ type: "enter" });
		await running;
		const frame = strip(io.writes);
		expect(frame).toContain("ping");
		expect(frame).toContain("AI");
		expect(frame).toContain("READY");
		const rows = paintedRows(io.writes);
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(row.length).toBeLessThanOrEqual(80);
		}
	});

	it("denies a confirmation and leaves the editor draft intact", async () => {
		const io = fakeIo();
		const streamFn = queuedStream([
			assistantMessage([{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }], "toolUse"),
			assistantMessage([{ type: "text", text: "stopped" }]),
		]);
		const tui = new InteractiveTui({ ...io, columns: 80, rows: 24 });
		const agent = new Agent({
			streamFn,
			beforeToolCall: createConfirmGate({
				autoYes: false,
				ask: async (name, args) => tui.confirmTool(name, args),
			}),
			initialState: {
				model: TEST_MODEL,
				tools: [
					{
						name: "bash",
						label: "bash",
						description: "bash",
						parameters: z.object({ command: z.string() }),
						async execute() {
							return { content: [{ type: "text", text: "ran" }], details: {} };
						},
					},
				],
			},
		});
		const running = runInteractive({ agent, tui, hasModel: true });
		tui.pushKey({ type: "char", value: "run it" });
		tui.pushKey({ type: "enter" });
		await new Promise((resolve) => setTimeout(resolve, 40));
		tui.pushKey({ type: "char", value: "n" });
		await new Promise((resolve) => setTimeout(resolve, 40));
		tui.pushKey({ type: "char", value: "/exit" });
		tui.pushKey({ type: "enter" });
		await running;
		expect(strip(io.writes)).toContain("CONFIRM");
	});

	it("submits live input while a run is active and interrupts with ctrl+c", async () => {
		const submitted: string[] = [];
		const io = fakeIo();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const streamFn = queuedStream([
			async () => {
				await gate;
				return assistantMessage([{ type: "text", text: "later" }]);
			},
		]);
		const tui = new InteractiveTui({
			...io,
			columns: 80,
			rows: 24,
			onSubmitDuringRun: (value) => submitted.push(value),
			onInterrupt: () => {},
		});
		const agent = new Agent({
			streamFn,
			initialState: { model: TEST_MODEL, tools: [] },
		});
		const running = runInteractive({ agent, tui, hasModel: true });
		tui.pushKey({ type: "char", value: "first" });
		tui.pushKey({ type: "enter" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		tui.setStreaming(true);
		tui.pushKey({ type: "char", value: "steer me" });
		tui.pushKey({ type: "enter" });
		expect(submitted).toEqual(["steer me"]);
		tui.pushKey({ type: "ctrl", value: "c" });
		expect(strip(io.writes)).toContain("abort requested");
		release();
		tui.close();
		await running;
	});

	it("restores a checkpoint through the session pickers", async () => {
		const io = fakeIo();
		const tui = new InteractiveTui({ ...io, columns: 80, rows: 24 });
		const agent = new Agent({
			streamFn: queuedStream([]),
			initialState: { model: TEST_MODEL, tools: [] },
		});
		const running = runInteractive({
			agent,
			tui,
			hasModel: true,
			listSessions: async () => ["sess-1"],
			onInspectSession: async () => ({
				ok: true,
				checkpoints: [{ id: "n1", label: "user: hi", depth: 0, onLivePath: true, isLeaf: true }],
			}),
			onRestoreCheckpoint: async () => [
				{ role: "user", content: [{ type: "text", text: "restored-user-turn" }], timestamp: 1 },
			],
		});
		tui.pushKey({ type: "char", value: "/sessions" });
		tui.pushKey({ type: "enter" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		tui.pushKey({ type: "enter" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		tui.pushKey({ type: "enter" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		tui.pushKey({ type: "char", value: "/exit" });
		tui.pushKey({ type: "enter" });
		await running;
		expect(strip(io.writes)).toContain("restored sess-1");
		expect(strip(io.writes)).toContain("restored-user-turn");
	});
});
