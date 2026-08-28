import { describe, expect, it } from "vitest";
import { rankSlashCompletions, slashCompletionToken } from "../src/completion.ts";
import { confirmChoiceFromKey, formatConfirmPrompt } from "../src/confirm.ts";
import { EditorBuffer } from "../src/editor.ts";
import { parseInputChunk, parseKey } from "../src/keys.ts";
import { renderFrame } from "../src/layout.ts";
import { InteractiveTui } from "../src/session.ts";

describe("keys + editor + confirm", () => {
	it("parses enter, editing keys, and alternate-enter", () => {
		expect(parseKey("\r")).toEqual({ type: "enter" });
		expect(parseKey("\t")).toEqual({ type: "tab" });
		expect(parseKey("\x1b[Z")).toEqual({ type: "shiftTab" });
		expect(parseKey("\x1b\r")).toEqual({ type: "newline" });
		expect(parseKey("\x7f")).toEqual({ type: "backspace" });
		expect(parseKey("\x1b[3~")).toEqual({ type: "delete" });
		expect(parseKey("\x1b[5~")).toEqual({ type: "pageUp" });
		expect(parseKey("\x1b[6~")).toEqual({ type: "pageDown" });
		expect(parseKey("\x1b[13;2u")).toEqual({ type: "newline" });
		expect(parseKey("\x03")).toEqual({ type: "ctrl", value: "c" });
		expect(parseKey("\x1b[A")).toEqual({ type: "up" });
		expect(parseKey("\x1b[200~pasted text\x1b[201~")).toEqual({ type: "paste", value: "pasted text" });
		expect(parseKey("hi")).toEqual({ type: "char", value: "hi" });
	});

	it("separates multiple raw keys and retains incomplete bracketed paste", () => {
		expect(parseInputChunk("/exit\r")).toEqual({
			keys: [{ type: "char", value: "/exit" }, { type: "enter" }],
			remainder: "",
		});
		expect(parseInputChunk("\x1b[200~partial")).toEqual({ keys: [], remainder: "\x1b[200~partial" });
		expect(parseInputChunk("\x1b[")).toEqual({ keys: [], remainder: "\x1b[" });
	});

	it("edits around the cursor and submits", () => {
		const editor = new EditorBuffer();
		editor.insert("ac");
		editor.moveLeft();
		editor.insert("b");
		editor.moveHome();
		editor.delete();
		editor.moveEnd();
		editor.backspace();
		expect(editor.value).toBe("b");
		editor.insert("eta");
		editor.insert("\nline");
		editor.moveUp();
		editor.moveEnd();
		expect(editor.displayLines()).toEqual(["beta|", "line"]);
		expect(editor.submit()).toBe("beta\nline");
		expect(editor.value).toBe("");
	});

	it("replaces a range without moving arguments or their relative cursor", () => {
		const editor = new EditorBuffer();
		editor.set("/ski arg text");
		editor.replaceRange(0, 4, "/skill");
		expect(editor.value).toBe("/skill arg text");
		expect(editor.cursorOffset).toBe(editor.value.length);
	});

	it("hides pasted content behind text and image placeholders", () => {
		const editor = new EditorBuffer();
		editor.insert("Describe ");
		editor.insertPastedText("a long private paste", "[Pasted text - 19 B]");
		editor.insertPastedImage("[Image - 1586 x 992]");
		expect(editor.displayLines().join("\n")).toContain("[Pasted text - 19 B]");
		expect(editor.displayLines().join("\n")).toContain("[Image - 1586 x 992]");
		expect(editor.displayLines().join("\n")).not.toContain("private paste");
		expect(editor.submit()).toBe("Describe a long private paste");
	});

	it("maps confirm keys", () => {
		expect(confirmChoiceFromKey({ type: "char", value: "y" })).toBe("once");
		expect(confirmChoiceFromKey({ type: "char", value: "a" })).toBe("always");
		expect(confirmChoiceFromKey({ type: "char", value: "n" })).toBe("deny");
		expect(formatConfirmPrompt({ toolName: "bash", args: { command: "ls" } })).toContain("bash");
	});
});

describe("slash completion ranking", () => {
	it("only exposes a single-line first token at the cursor", () => {
		expect(slashCompletionToken("/ski arg", 4)).toEqual({ query: "/ski", start: 0, end: 4 });
		expect(slashCompletionToken("/ski arg", 5)).toEqual({ query: "/ski", start: 0, end: 4 });
		expect(slashCompletionToken("/ski\nmore", 4)).toBeUndefined();
	});

	it("orders exact, prefix, substring, and fuzzy matches", () => {
		const candidates = [
			{ token: "/reload", description: "fuzzy", kind: "command" as const },
			{ token: "x/rl", description: "substring", kind: "command" as const },
			{ token: "/rload", description: "prefix", kind: "command" as const },
			{ token: "/rl", description: "exact", kind: "skill" as const },
		];
		expect(rankSlashCompletions(candidates, "/rl").map((item) => item.description)).toEqual([
			"exact",
			"prefix",
			"substring",
			"fuzzy",
		]);
	});

	it("uses command kind and token name as stable ties and enforces the row limit", () => {
		const candidates = [
			{ token: "/saga", description: "skill", kind: "skill" as const },
			{ token: "/status", description: "command", kind: "command" as const },
			{ token: "/sessions", description: "command", kind: "command" as const },
		];
		expect(rankSlashCompletions(candidates, "/s", 2).map((item) => item.token)).toEqual(["/sessions", "/status"]);
	});
});

describe("renderFrame", () => {
	it("keeps status, semantic transcript, editor, and hint", () => {
		const lines = renderFrame(
			{
				status: "model=gpt cwd=/tmp",
				transcript: [
					{ id: "user", kind: "user", text: "hi" },
					{ id: "assistant", kind: "assistant", text: "hello" },
				],
				editorLines: [""],
				streaming: false,
			},
			40,
			10,
		);
		const frame = lines.map(stripAnsi).join("\n");
		expect(frame).toContain("model=gpt");
		expect(frame).toContain("YOU hi");
		expect(frame).toContain("AI  hello");
		expect(frame).toContain("Enter send");
	});

	it("fits a narrow viewport and strips untrusted terminal controls", () => {
		const lines = renderFrame(
			{
				status: "model=gpt\x1b[2J",
				transcript: [
					{ id: "assistant", kind: "assistant", text: "line one\nline two\x1b[31m" },
					{
						id: "tool",
						kind: "tool",
						text: "",
						tool: {
							toolCallId: "call-1",
							toolName: "bash",
							argsText: '{"command":"ls"}',
							state: "running",
						},
					},
				],
				editorLines: [""],
				streaming: false,
			},
			28,
			11,
		);
		const frame = lines.map(stripAnsi);
		expect(frame).toHaveLength(11);
		expect(frame.join("\n")).toContain("line two");
		expect(frame.join("\n")).toContain("TOOL bash");
		expect(frame.join("")).not.toContain("\x1b");
		for (const line of frame) {
			expect(line.length).toBeLessThanOrEqual(28);
		}
	});

	it("shows selected tool details inline in the transcript", () => {
		const frame = renderFrame(
			{
				status: "model=gpt",
				header: { cwd: "/tmp/project", model: "gpt", session: "branch-a" },
				transcript: [
					{
						id: "tool",
						kind: "tool",
						text: "",
						tool: {
							toolCallId: "call-1",
							toolName: "read",
							argsText: '{"path":"a.ts"}',
							state: "success",
							outputText: "export const value = 1;",
							detailsText: '{"path":"a.ts"}',
							durationMs: 18,
						},
					},
				],
				editorLines: ["|"],
				streaming: false,
				colors: false,
				inspector: {
					tool: {
						toolCallId: "call-1",
						toolName: "read",
						argsText: '{"path":"a.ts"}',
						state: "success",
						outputText: "export const value = 1;",
						detailsText: '{"path":"a.ts"}',
						durationMs: 18,
					},
				},
			},
			120,
			24,
		).map(stripAnsi);
		const text = frame.join("\n");
		expect(text).toContain("SUMMARY");
		expect(text).toContain("duration: 18 ms");
		for (const line of frame) {
			expect(line.length).toBeLessThanOrEqual(120);
		}
	});

	it("shows compact context in the header when provided", () => {
		const frame = renderFrame(
			{
				status: "model=fast",
				header: {
					cwd: "/tmp/project",
					model: "fast(gpt-4.1-mini)",
					context: "128k",
					session: "branch-a",
				},
				transcript: [],
				editorLines: [""],
				streaming: false,
				colors: false,
			},
			120,
			12,
		).map(stripAnsi);
		const header = frame[0] ?? "";
		expect(header).toContain("model: fast(gpt-4.1-mini)");
		expect(header).toContain("ctx: 128k");
		expect(header).toContain("session: branch-a");
	});

	it("keeps shortcut hints complete at common terminal widths", () => {
		const frame = renderFrame(
			{
				status: "model=gpt",
				transcript: [],
				editorLines: ["|"],
				streaming: false,
				colors: false,
			},
			72,
			10,
		).join("\n");
		expect(frame).toContain("Ctrl+C exit");
		expect(frame).not.toContain("...");
	});

	it("keeps the live editor usable and bounds the inline inspector at 80x24", () => {
		const completedTool = {
			toolCallId: "call-1",
			toolName: "read",
			argsText: '{"path":"a.ts"}',
			state: "success" as const,
			outputText: "done",
		};
		const frame = renderFrame(
			{
				status: "model=gpt",
				header: { cwd: "/tmp/project", model: "gpt", session: "branch-a" },
				transcript: [
					{ id: "done", kind: "tool", text: "", tool: completedTool },
					{
						id: "fail",
						kind: "tool",
						text: "",
						tool: { ...completedTool, toolCallId: "call-2", toolName: "test", state: "error" },
					},
				],
				editorLines: ["Refine parser|", "[Pasted text - 1.2 KB]  [Image - 1586 x 992]"],
				streaming: true,
				colors: false,
				inspector: { tool: completedTool },
			},
			80,
			24,
		);
		const text = frame.join("\n");
		expect(frame).toHaveLength(24);
		expect(text).toContain("status: RUNNING");
		expect(text).toContain("DONE");
		expect(text).toContain("FAIL");
		expect(text).toContain("[Pasted text - 1.2 KB]");
		expect(text).toContain("Ctrl+C interrupt");
		expect(text).not.toContain("TOOL DETAILS");
		for (const line of frame) {
			expect(line.length).toBeLessThanOrEqual(80);
		}
	});

	it("keeps a selected historical tool visible and reports unseen events", () => {
		const firstTool = {
			toolCallId: "call-1",
			toolName: "read",
			argsText: '{"path":"a.ts"}',
			state: "success" as const,
		};
		const frame = renderFrame(
			{
				status: "model=gpt",
				transcript: [
					{ id: "first", kind: "tool", text: "", tool: firstTool },
					{ id: "second", kind: "assistant", text: "new assistant output" },
				],
				editorLines: ["|"],
				streaming: true,
				colors: false,
				focus: "transcript",
				selectedToolCallId: "call-1",
				followLatest: false,
				unseenEventCount: 2,
			},
			80,
			24,
		).join("\n");
		expect(frame).toContain(">TOOL read");
		expect(frame).toContain("2 new events");
	});

	it("reveals earlier messages when a transcript scroll offset is set", () => {
		const transcript = Array.from({ length: 40 }, (_, index) => ({
			id: `entry-${index}`,
			kind: "info" as const,
			text: `message ${index}`,
		}));
		const frame = renderFrame(
			{
				status: "model=gpt",
				transcript,
				editorLines: ["|"],
				streaming: false,
				colors: false,
				focus: "transcript",
				transcriptScrollOffset: 0,
			},
			80,
			24,
		).join("\n");
		expect(frame).toContain("message 0");
		expect(frame).not.toContain("message 39");
	});

	it("anchors to the latest content without a scroll offset", () => {
		const transcript = Array.from({ length: 40 }, (_, index) => ({
			id: `entry-${index}`,
			kind: "info" as const,
			text: `message ${index}`,
		}));
		const frame = renderFrame(
			{
				status: "model=gpt",
				transcript,
				editorLines: ["|"],
				streaming: false,
				colors: false,
			},
			80,
			24,
		).join("\n");
		expect(frame).not.toContain("message 0");
		expect(frame).toContain("message 39");
	});

	it("renders a sanitized completion popup with at most six rows", () => {
		const items = Array.from({ length: 9 }, (_, index) => ({
			token: `/command-${index}`,
			description: index === 0 ? "unsafe\x1b[2J\nnext" : `description ${index}`,
			kind: "command" as const,
		}));
		const frame = renderFrame(
			{
				status: "model=gpt",
				transcript: [],
				editorLines: ["/command|"],
				completion: { items, index: 0, tokenStart: 0, tokenEnd: 8 },
				streaming: false,
				colors: false,
			},
			80,
			24,
		);
		const popupRows = frame.filter((line) => line.includes("[command]"));
		expect(frame).toHaveLength(24);
		expect(popupRows).toHaveLength(6);
		expect(frame.join("\n")).toContain("> /command-0");
		expect(frame.join("\n")).not.toContain("\x1b");
		for (const line of frame) {
			expect(line.length).toBeLessThanOrEqual(80);
		}
		const compactFrame = renderFrame(
			{
				status: "model=gpt",
				transcript: [],
				editorLines: ["/command|"],
				completion: { items, index: 0, tokenStart: 0, tokenEnd: 8 },
				streaming: false,
				colors: false,
			},
			80,
			10,
		);
		expect(compactFrame).toHaveLength(10);
		expect(compactFrame.filter((line) => line.includes("[command]"))).toHaveLength(2);
		const cycledFrame = renderFrame(
			{
				status: "model=gpt",
				transcript: [],
				editorLines: ["/command-8|"],
				completion: { items, index: 8, tokenStart: 0, tokenEnd: 10 },
				streaming: false,
				colors: false,
			},
			80,
			24,
		).join("\n");
		expect(cycledFrame).toContain("> /command-8");
		expect(cycledFrame).not.toContain("/command-0");
	});
});

describe("InteractiveTui", () => {
	it("resolves a prompt on enter and a confirm on y", async () => {
		const writes: string[] = [];
		let pauses = 0;
		const stdout = {
			write: (chunk: string) => {
				writes.push(chunk);
				return true;
			},
			columns: 40,
			rows: 10,
		} as unknown as NodeJS.WriteStream;
		const stdin = {
			isTTY: false,
			on() {},
			off() {},
			pause() {
				pauses += 1;
			},
			setRawMode() {},
		} as unknown as NodeJS.ReadStream;
		const tui = new InteractiveTui({ stdin, stdout, status: () => "test" });
		const prompt = tui.readPrompt();
		tui.pushKey({ type: "char", value: "go" });
		tui.pushKey({ type: "enter" });
		await expect(prompt).resolves.toBe("go");

		const confirm = tui.confirmTool("write", { path: "a.ts" });
		tui.pushKey({ type: "char", value: "y" });
		await expect(confirm).resolves.toBe("once");
		tui.close();
		expect(pauses).toBe(1);
	});

	it("recalls prompt history from a single-line editor", async () => {
		const stdout = {
			write: () => true,
			columns: 60,
			rows: 12,
		} as unknown as NodeJS.WriteStream;
		const stdin = { isTTY: false, on() {}, off() {}, setRawMode() {} } as unknown as NodeJS.ReadStream;
		const tui = new InteractiveTui({ stdin, stdout });
		const first = tui.readPrompt();
		tui.pushKey({ type: "char", value: "first prompt" });
		tui.pushKey({ type: "enter" });
		await expect(first).resolves.toBe("first prompt");

		const recalled = tui.readPrompt();
		tui.pushKey({ type: "up" });
		tui.pushKey({ type: "enter" });
		await expect(recalled).resolves.toBe("first prompt");
		tui.close();
	});

	it("searches a picker and opens the command palette with ctrl-p", async () => {
		const stdout = {
			write: () => true,
			columns: 60,
			rows: 12,
		} as unknown as NodeJS.WriteStream;
		const stdin = { isTTY: false, on() {}, off() {}, setRawMode() {} } as unknown as NodeJS.ReadStream;
		const tui = new InteractiveTui({ stdin, stdout });
		const pick = tui.pickFromList("Commands", ["/status  Runtime details", "/compact  Compact context"]);
		tui.pushKey({ type: "char", value: "compact" });
		tui.pushKey({ type: "enter" });
		await expect(pick).resolves.toBe(1);

		const command = tui.readPrompt();
		tui.pushKey({ type: "ctrl", value: "p" });
		await expect(command).resolves.toBe("/commands");
		tui.close();
	});

	it("picks a list item and reports interrupt while streaming", async () => {
		let interrupted = 0;
		const stdout = {
			write: () => true,
			columns: 40,
			rows: 10,
		} as unknown as NodeJS.WriteStream;
		const stdin = { isTTY: false, on() {}, off() {}, setRawMode() {} } as unknown as NodeJS.ReadStream;
		const tui = new InteractiveTui({
			stdin,
			stdout,
			onInterrupt: () => {
				interrupted += 1;
			},
		});
		const pick = tui.pickFromList("Sessions", ["(new)", "abc"]);
		tui.pushKey({ type: "down" });
		tui.pushKey({ type: "enter" });
		await expect(pick).resolves.toBe(1);

		tui.setStreaming(true);
		tui.pushKey({ type: "ctrl", value: "c" });
		expect(interrupted).toBe(1);
		tui.close();
	});

	it("keeps the editor active and submits through the running callback", () => {
		const submitted: string[] = [];
		const stdout = {
			write: () => true,
			columns: 80,
			rows: 24,
		} as unknown as NodeJS.WriteStream;
		const stdin = { isTTY: false, on() {}, off() {}, setRawMode() {} } as unknown as NodeJS.ReadStream;
		const tui = new InteractiveTui({ stdin, stdout, onSubmitDuringRun: (value) => submitted.push(value) });
		tui.setStreaming(true);
		tui.pushKey({ type: "char", value: "keep going" });
		tui.pushKey({ type: "enter" });
		expect(submitted).toEqual(["keep going"]);
		tui.close();
	});

	it("focuses a tool, expands an inline inspector, and returns to the editor", async () => {
		const writes: string[] = [];
		const stdout = {
			write: (chunk: string) => {
				writes.push(chunk);
				return true;
			},
			columns: 100,
			rows: 24,
		} as unknown as NodeJS.WriteStream;
		const stdin = { isTTY: false, on() {}, off() {}, setRawMode() {} } as unknown as NodeJS.ReadStream;
		const tui = new InteractiveTui({ stdin, stdout, colors: false });
		tui.appendToolStart("call-1", "edit", {
			path: "parser.ts",
			edits: [{ oldText: "throw old", newText: "throw next" }],
		});
		tui.appendToolEnd("call-1", "Edited parser.ts (1 replacement)", false);
		tui.pushKey({ type: "tab" });
		tui.pushKey({ type: "enter" });
		expect(stripAnsi(writes.join(""))).toContain("SUMMARY");
		tui.pushKey({ type: "right" });
		tui.pushKey({ type: "right" });
		expect(stripAnsi(writes.join(""))).toContain("- throw old");
		tui.pushKey({ type: "escape" });
		tui.pushKey({ type: "char", value: "next" });
		const prompt = tui.readPrompt();
		tui.pushKey({ type: "enter" });
		await expect(prompt).resolves.toBe("next");
		tui.close();
	});

	it("preserves an idle submission that arrives before the next prompt read", async () => {
		const stdout = {
			write: () => true,
			columns: 80,
			rows: 24,
		} as unknown as NodeJS.WriteStream;
		const stdin = { isTTY: false, on() {}, off() {}, setRawMode() {} } as unknown as NodeJS.ReadStream;
		const tui = new InteractiveTui({ stdin, stdout });
		tui.pushKey({ type: "char", value: "next prompt" });
		tui.pushKey({ type: "enter" });
		await expect(tui.readPrompt()).resolves.toBe("next prompt");
		tui.close();
	});

	it("accepts and cycles slash completions without changing arguments", async () => {
		const stdout = {
			write: () => true,
			columns: 80,
			rows: 24,
		} as unknown as NodeJS.WriteStream;
		const stdin = { isTTY: false, on() {}, off() {}, setRawMode() {} } as unknown as NodeJS.ReadStream;
		const tui = new InteractiveTui({
			stdin,
			stdout,
			completionCandidates: () => [
				{ token: "/skill", description: "Invoke a skill", kind: "command" },
				{ token: "/skills", description: "List skills", kind: "command" },
			],
		});
		const prompt = tui.readPrompt();
		tui.pushKey({ type: "char", value: "/ski arg text" });
		tui.pushKey({ type: "tab" });
		tui.pushKey({ type: "tab" });
		tui.pushKey({ type: "enter" });
		await expect(prompt).resolves.toBe("/skills arg text");
		tui.close();
	});

	it("cycles through candidates beyond the visible popup rows", async () => {
		const stdout = {
			write: () => true,
			columns: 80,
			rows: 24,
		} as unknown as NodeJS.WriteStream;
		const stdin = { isTTY: false, on() {}, off() {}, setRawMode() {} } as unknown as NodeJS.ReadStream;
		const tui = new InteractiveTui({
			stdin,
			stdout,
			completionRows: 2,
			completionCandidates: () =>
				Array.from({ length: 8 }, (_, index) => ({
					token: `/command-${index}`,
					description: `Command ${index}`,
					kind: "command" as const,
				})),
		});
		const prompt = tui.readPrompt();
		tui.pushKey({ type: "char", value: "/command- keep" });
		for (let index = 0; index < 8; index += 1) {
			tui.pushKey({ type: "tab" });
		}
		tui.pushKey({ type: "enter" });
		await expect(prompt).resolves.toBe("/command-7 keep");
		tui.close();
	});

	it("cycles slash completions backward and lets escape cancel", async () => {
		const stdout = {
			write: () => true,
			columns: 80,
			rows: 24,
		} as unknown as NodeJS.WriteStream;
		const stdin = { isTTY: false, on() {}, off() {}, setRawMode() {} } as unknown as NodeJS.ReadStream;
		const candidates = () => [
			{ token: "/skill", description: "Invoke a skill", kind: "command" as const },
			{ token: "/skills", description: "List skills", kind: "command" as const },
		];
		const reverseTui = new InteractiveTui({ stdin, stdout, completionCandidates: candidates });
		const reversePrompt = reverseTui.readPrompt();
		reverseTui.pushKey({ type: "char", value: "/ski keep" });
		reverseTui.pushKey({ type: "shiftTab" });
		reverseTui.pushKey({ type: "enter" });
		await expect(reversePrompt).resolves.toBe("/skills keep");
		reverseTui.close();

		const cancelTui = new InteractiveTui({ stdin, stdout, completionCandidates: candidates });
		const cancelPrompt = cancelTui.readPrompt();
		cancelTui.pushKey({ type: "char", value: "/ski keep" });
		cancelTui.pushKey({ type: "escape" });
		cancelTui.pushKey({ type: "tab" });
		cancelTui.pushKey({ type: "escape" });
		cancelTui.pushKey({ type: "enter" });
		await expect(cancelPrompt).resolves.toBe("/ski keep");
		cancelTui.close();
	});

	it("scrolls a long transcript back and forth with PgUp/PgDn/Home/End", () => {
		const writes: string[] = [];
		const stdout = {
			write: (chunk: string) => {
				writes.push(chunk);
				return true;
			},
			columns: 80,
			rows: 24,
		} as unknown as NodeJS.WriteStream;
		const stdin = { isTTY: false, on() {}, off() {}, setRawMode() {} } as unknown as NodeJS.ReadStream;
		const tui = new InteractiveTui({ stdin, stdout, colors: false });
		for (let index = 0; index < 40; index += 1) {
			tui.appendLine(`old message ${index}`);
		}
		const lastFrame = () => stripAnsi(writes[writes.length - 1] ?? "");
		expect(lastFrame()).toContain("old message 39");
		expect(lastFrame()).not.toContain("old message 0");

		tui.pushKey({ type: "tab" }); // transcript focus works without tool entries
		tui.pushKey({ type: "home" }); // jump to the first message
		expect(lastFrame()).toContain("old message 0");

		tui.pushKey({ type: "pageDown" }); // scroll forward
		tui.pushKey({ type: "end" }); // back to the latest content
		expect(lastFrame()).toContain("old message 39");
		tui.close();
	});
});

function stripAnsi(text: string): string {
	let output = "";
	let escapeState = 0;
	for (const char of text) {
		if (char === "\u001b") {
			escapeState = 1;
			continue;
		}
		if (escapeState === 1) {
			escapeState = char === "[" ? 2 : 0;
			continue;
		}
		if (escapeState === 2) {
			const code = char.codePointAt(0) ?? 0;
			if (code >= 0x40 && code <= 0x7e) {
				escapeState = 0;
			}
			continue;
		}
		output += char;
	}
	return output;
}
