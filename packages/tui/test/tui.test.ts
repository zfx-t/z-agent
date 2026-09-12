import { describe, expect, it } from "vitest";
import { rankSlashCompletions, slashCompletionToken } from "../src/completion.ts";
import { confirmChoiceFromKey, formatConfirmPrompt } from "../src/confirm.ts";
import { EditorBuffer } from "../src/editor.ts";
import { parseInputChunk, parseKey } from "../src/keys.ts";
import { renderFrame, renderFrameEx } from "../src/layout.ts";
import { InteractiveTui } from "../src/session.ts";
import { cellWidth, setAmbiguousWide, visibleWidth } from "../src/text.ts";
import { availableInspectorViews, detailLines } from "../src/tool-detail.ts";

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
		expect(parseKey("\x1bOA")).toEqual({ type: "up" });
		expect(parseKey("\x1b[200~pasted text\x1b[201~")).toEqual({ type: "paste", value: "pasted text" });
		expect(parseKey("hi")).toEqual({ type: "char", value: "hi" });
		expect(parseKey("\x1b[1;5D")).toEqual({ type: "wordLeft" });
		expect(parseKey("\x1b[1;5C")).toEqual({ type: "wordRight" });
		expect(parseKey("\x1b[1;3D")).toEqual({ type: "wordLeft" });
		expect(parseKey("\x1b[3;5~")).toEqual({ type: "deleteWordForward" });
		expect(parseKey("\x1b\x7f")).toEqual({ type: "deleteWordBack" });
	});

	it("separates multiple raw keys and retains incomplete bracketed paste", () => {
		expect(parseInputChunk("/exit\r")).toEqual({
			keys: [{ type: "char", value: "/exit" }, { type: "enter" }],
			remainder: "",
		});
		expect(parseInputChunk("\x1b[200~partial")).toEqual({ keys: [], remainder: "\x1b[200~partial" });
		expect(parseInputChunk("\x1b[")).toEqual({ keys: [], remainder: "\x1b[" });
	});

	it("parses SGR mouse wheel reports and button events with coordinates", () => {
		expect(parseInputChunk("\x1b[<64;80;10M")).toEqual({
			keys: [{ type: "wheelUp", col: 79, row: 9 }],
			remainder: "",
		});
		expect(parseInputChunk("\x1b[<65;1;1M")).toEqual({
			keys: [{ type: "wheelDown", col: 0, row: 0 }],
			remainder: "",
		});
		expect(parseInputChunk("\x1b[<68;1;1M")).toEqual({
			keys: [{ type: "wheelUp", col: 0, row: 0 }],
			remainder: "",
		});
		expect(parseInputChunk("\x1b[<0;5;5M\x1b[<0;5;5m")).toEqual({
			keys: [
				{
					type: "mouse",
					event: { kind: "down", button: "left", col: 4, row: 4, shift: false, alt: false, ctrl: false },
				},
				{
					type: "mouse",
					event: { kind: "up", button: "left", col: 4, row: 4, shift: false, alt: false, ctrl: false },
				},
			],
			remainder: "",
		});
		expect(parseInputChunk("\x1b[<64")).toEqual({ keys: [], remainder: "\x1b[<64" });
	});

	it("parses selection and modified-enter keys", () => {
		expect(parseKey("\x1b[1;2D")).toEqual({ type: "selectLeft" });
		expect(parseKey("\x1b[1;2C")).toEqual({ type: "selectRight" });
		expect(parseKey("\x1b[1;2A")).toEqual({ type: "selectUp" });
		expect(parseKey("\x1b[1;2B")).toEqual({ type: "selectDown" });
		expect(parseKey("\x1b[1;6D")).toEqual({ type: "selectWordLeft" });
		expect(parseKey("\x1b[1;4C")).toEqual({ type: "selectWordRight" });
		expect(parseKey("\x1b[1;2H")).toEqual({ type: "selectHome" });
		expect(parseKey("\x1b[1;2F")).toEqual({ type: "selectEnd" });
		expect(parseKey("\x1b[13;5u")).toEqual({ type: "ctrlEnter" });
		expect(parseKey("\x1b[13;4u")).toEqual({ type: "newline" });
		expect(parseInputChunk("\x1b[1;2")).toEqual({ keys: [], remainder: "\x1b[1;2" });
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
		expect(editor.displayLines()).toEqual(["beta", "line"]);
		expect(editor.displayCursor()).toEqual({ row: 0, col: 4 });
		expect(editor.submit()).toBe("beta\nline");
		expect(editor.value).toBe("");
	});

	it("moves and deletes by word and kills to line end", () => {
		const editor = new EditorBuffer();
		editor.set("alpha beta  gamma\nsecond line");
		editor.moveWordLeft();
		expect(editor.cursorOffset).toBe(25);
		editor.moveWordLeft();
		expect(editor.cursorOffset).toBe(18);
		editor.deleteWordForward();
		expect(editor.value).toBe("alpha beta  gamma\n line");
		editor.killToLineEnd();
		expect(editor.value).toBe("alpha beta  gamma\n");
		editor.set("ab\ncd");
		editor.moveWordLeft();
		editor.moveLeft();
		editor.killToLineEnd();
		expect(editor.value).toBe("abcd");
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

	it("extends a selection and replaces it on type", () => {
		const editor = new EditorBuffer();
		editor.set("hello world");
		editor.extendLeft();
		editor.extendLeft();
		editor.extendLeft();
		editor.extendLeft();
		editor.extendLeft();
		expect(editor.selectionRange).toEqual({ start: 6, end: 11 });
		expect(editor.displaySelection()).toEqual([{ row: 0, start: 6, end: 11 }]);
		editor.insert("there");
		expect(editor.value).toBe("hello there");
		expect(editor.selectionRange).toBeUndefined();
		expect(editor.cursorOffset).toBe(11);
	});

	it("extends selection by word, line bounds, and rows; backspace deletes it", () => {
		const editor = new EditorBuffer();
		editor.set("alpha beta\ngamma delta");
		editor.moveEnd();
		editor.extendWordLeft();
		expect(editor.selectionRange).toEqual({ start: 17, end: 22 });
		editor.moveRight();
		expect(editor.selectionRange).toBeUndefined();
		editor.extendHome();
		expect(editor.selectionRange).toEqual({ start: 11, end: 22 });
		editor.extendUp();
		expect(editor.selectionRange).toEqual({ start: 0, end: 22 });
		editor.backspace();
		expect(editor.value).toBe("");
		editor.set("ab\ncd");
		editor.moveHome();
		editor.moveUp();
		editor.extendEnd();
		expect(editor.selectionRange).toEqual({ start: 0, end: 2 });
		editor.delete();
		expect(editor.value).toBe("\ncd");
	});

	it("maps a display cell back to the source offset", () => {
		const editor = new EditorBuffer();
		editor.set("ab\ncde");
		editor.setCursorFromDisplay(1, 2);
		expect(editor.cursorOffset).toBe(5);
		editor.setCursorFromDisplay(0, 0);
		expect(editor.cursorOffset).toBe(0);
		editor.setCursorFromDisplay(1, 2, true);
		expect(editor.selectionRange).toEqual({ start: 0, end: 5 });
	});

	it("maps display cells across cleaned-out tabs and control bytes", () => {
		const editor = new EditorBuffer();
		editor.set("a\tb"); // displays as "a  b"
		expect(editor.displayLines()).toEqual(["a  b"]);
		editor.setCursorFromDisplay(0, 3); // click on 'b'
		expect(editor.cursorOffset).toBe(2);
		editor.set("\x07end"); // control byte is dropped from display
		expect(editor.displayLines()).toEqual(["end"]);
		editor.setCursorFromDisplay(0, 2); // click on 'd'
		expect(editor.cursorOffset).toBe(3);
	});

	it("extends a selection through a placeholder chip's end", () => {
		const editor = new EditorBuffer();
		editor.insertPastedText("secret bytes", "[P]");
		editor.moveHome();
		editor.extendEnd();
		expect(editor.displaySelection()).toEqual([{ row: 0, start: 0, end: 3 }]);
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
		expect(frame).toContain("YOU   hi");
		expect(frame).toContain("AI    hello");
		expect(frame).toContain("enter send");
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
		expect(frame.join("\n")).toContain("TOOL  bash");
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

	it("drops low-priority header segments before the run state at 80 columns", () => {
		const frame = renderFrame(
			{
				status: "model=fast",
				header: {
					cwd: "/very/long/working/directory/path/that/will/not/fit",
					model: "fast(gpt-4.1-mini)",
					session: "branch-a",
					segments: [
						{ id: "cwd", text: "cwd: /very/long/working/directory/path/that/will/not/fit", priority: 40 },
						{ id: "model", text: "model: fast(gpt-4.1-mini)", priority: 80 },
						{ id: "ctx", text: "ctx: 12k/128k 9%", priority: 90 },
						{ id: "session", text: "session: branch-a", priority: 30 },
						{ id: "ext", text: "ext: a-very-long-extension-status-segment", priority: 10 },
					],
				},
				transcript: [],
				editorLines: [""],
				streaming: true,
				colors: false,
			},
			80,
			24,
		).map(stripAnsi);
		const header = frame[0] ?? "";
		expect(visibleWidth(header)).toBeLessThanOrEqual(80);
		expect(header).toContain("RUNNING");
		expect(header).toContain("ctx: 12k/128k 9%");
		expect(header).toContain("model: fast(gpt-4.1-mini)");
		expect(header).not.toContain("a-very-long-extension");
		expect(header).not.toContain("/very/long/working");
	});

	it("uses a tool renderer and falls back when it throws", () => {
		const tool = {
			toolCallId: "1",
			toolName: "ping",
			argsText: "{}",
			state: "success" as const,
			outputText: "pong",
		};
		expect(detailLines(tool, "output", () => ({ output: ["custom pong"] }))).toEqual(["custom pong"]);
		expect(availableInspectorViews(tool, () => ({ diff: ["+ one"] }))).toEqual(["summary", "output", "diff"]);
		expect(
			detailLines(tool, "output", () => {
				throw new Error("nope");
			}),
		).toEqual(["pong"]);
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
		expect(frame).toContain("ctrl+c exit");
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
		expect(text).toContain("RUNNING");
		expect(text).toContain("DONE");
		expect(text).toContain("FAIL");
		expect(text).toContain("[Pasted text - 1.2 KB]");
		expect(text).toContain("ctrl+c interrupt");
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
				selectedEntryId: "first",
				followLatest: false,
				unseenEventCount: 2,
			},
			80,
			24,
		).join("\n");
		expect(frame).toContain(">TOOL  read");
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

	it("keeps a gap between the longest completion token and its description", () => {
		const frame = renderFrame(
			{
				status: "model=gpt",
				transcript: [],
				editorLines: ["/s|"],
				completion: {
					items: [
						{ token: "/sessions", description: "Browse sessions", kind: "command" },
						{ token: "/reset", description: "Reset context", kind: "command" },
					],
					index: 0,
					tokenStart: 0,
					tokenEnd: 2,
				},
				streaming: false,
				colors: false,
			},
			80,
			24,
		).join("\n");
		expect(frame).toContain("> /sessions  Browse sessions");
		expect(frame).toContain(" /reset     Reset context");
	});

	it("renders assistant markdown while leaving user text literal", () => {
		const frame = renderFrame(
			{
				status: "model=gpt",
				transcript: [
					{ id: "user", kind: "user", text: "use **bold**" },
					{
						id: "assistant",
						kind: "assistant",
						text: "# Done\n\nUse `renderMarkdown` and [docs](https://example.com).",
					},
				],
				editorLines: [""],
				streaming: false,
				colors: false,
			},
			72,
			16,
		).map(stripAnsi);
		const text = frame.join("\n");
		expect(text).toContain("YOU   use **bold**");
		expect(text).toContain("# Done");
		expect(text).toContain("Use `renderMarkdown` and docs (https://example.com).");
		expect(text).not.toContain("[docs](https://example.com)");
		for (const line of frame) {
			expect(line.length).toBeLessThanOrEqual(72);
		}
	});

	it("leaves thinking, tool, and inspector rows as literal markdown source", () => {
		const tool = {
			toolCallId: "call-md",
			toolName: "bash",
			argsText: '{"command":"**star**"}',
			state: "success" as const,
			outputText: "# Title\n\nHello **bold**",
		};
		const frame = renderFrame(
			{
				status: "model=gpt",
				transcript: [
					{ id: "think", kind: "thinking", text: "plan **secret** and `x`" },
					{ id: "tool", kind: "tool", text: "# ignored heading", tool },
				],
				editorLines: [""],
				streaming: false,
				colors: false,
				inspector: { tool, view: "output" },
			},
			72,
			20,
		).map(stripAnsi);
		const text = frame.join("\n");
		expect(text).toContain("THINK plan **secret** and `x`");
		expect(text).toContain('TOOL  bash {"command":"**star**"}');
		expect(text).toContain("# Title");
		expect(text).toContain("Hello **bold**");
		expect(text).not.toContain("plan secret");
		expect(text).not.toContain("Hello bold");
	});

	it("keeps 80x24 assistant markdown inside the viewport", () => {
		const frame = renderFrame(
			{
				status: "model=gpt",
				transcript: [
					{
						id: "assistant",
						kind: "assistant",
						text: "```js\nconsole.log('abcdefghijklmnopqrstuvwxyz0123456789');\n```",
					},
				],
				editorLines: ["|"],
				streaming: true,
				colors: false,
			},
			80,
			24,
		).map(stripAnsi);
		expect(frame).toHaveLength(24);
		expect(frame.join("\n")).toContain("```js");
		const rawCode = "console.log('abcdefghijklmnopqrstuvwxyz0123456789');";
		const bodyWidth = 80 - visibleWidth(" AI  ");
		const codeBodies = frame.map((line) => line.replace(/^\s*AI\s+/, ""));
		expect(visibleWidth(rawCode)).toBeGreaterThan(40);
		expect(codeBodies.some((line) => line.includes("console.log"))).toBe(true);
		expect(codeBodies.some((line) => line.includes("abcdefghijklmnopqrstuvwxyz0123456789"))).toBe(true);
		for (const line of codeBodies) {
			if (!/console|abcdefghijklmnopqrstuvwxyz|0123456789/u.test(line)) {
				continue;
			}
			expect(visibleWidth(line)).toBeLessThanOrEqual(bodyWidth);
		}
		for (const line of frame) {
			expect(line.length).toBeLessThanOrEqual(80);
		}
	});
});

describe("renderFrame detail rows", () => {
	const base = { status: "model=gpt", transcript: [], editorLines: [""], streaming: false, colors: false };

	it("renders tool target summaries, durations, and output previews", () => {
		const frame = renderFrame(
			{
				...base,
				transcript: [
					{
						id: "t1",
						kind: "tool",
						text: "",
						tool: {
							toolCallId: "c1",
							toolName: "bash",
							input: { command: "npm test" },
							argsText: '{"command":"npm test"}',
							state: "success",
							outputText: "12 passed\n3 skipped",
							durationMs: 1530,
						},
					},
				],
			},
			80,
			24,
		).join("\n");
		expect(frame).toContain("TOOL  bash $ npm test");
		expect(frame).toContain("DONE 1.5s");
		expect(frame).toContain("⎿ 12 passed · +1 lines");
	});

	it("marks steered input queued and collapses hidden thinking", () => {
		const frame = renderFrame(
			{
				...base,
				transcript: [
					{ id: "u", kind: "user", text: "keep going", queued: true },
					{ id: "t", kind: "thinking", text: "secret plan", hidden: true },
				],
			},
			80,
			24,
		).join("\n");
		expect(frame).toContain("YOU   keep going  (queued)");
		expect(frame).toContain("THINK (hidden — ctrl+t to expand)");
		expect(frame).not.toContain("secret plan");
	});

	it("shows a waiting row when streaming with no active entry", () => {
		const frame = renderFrame(
			{
				...base,
				streaming: true,
				motion: false,
				transcript: [{ id: "u", kind: "user", text: "go" }],
			},
			80,
			24,
		).join("\n");
		expect(frame).toContain("waiting for model");
	});

	it("positions a real cursor in the editor and hides it for transcript focus", () => {
		const withCursor = renderFrameEx(
			{ ...base, editorLines: ["fix the bug"], editorCursor: { row: 0, col: 4 } },
			80,
			24,
		);
		expect(withCursor.cursor).toBeDefined();
		expect(withCursor.cursor?.col).toBe(8);
		const unfocused = renderFrameEx(
			{ ...base, editorLines: ["fix the bug"], editorCursor: { row: 0, col: 4 }, focus: "transcript" },
			80,
			24,
		);
		expect(unfocused.cursor).toBeUndefined();
	});

	it("keeps every painted line inside the width under double-width ambiguous glyphs", () => {
		setAmbiguousWide(true);
		try {
			expect(cellWidth("─")).toBe(2);
			const frame = renderFrameEx(
				{
					...base,
					glyphTheme: "unicode",
					streaming: true,
					transcript: [
						{ id: "u", kind: "user", text: "先按字面找到这两个" },
						{
							id: "t1",
							kind: "tool",
							text: "",
							tool: {
								toolCallId: "c1",
								toolName: "bash",
								input: { command: "cp -r src dst" },
								argsText: "{}",
								state: "running",
								startedAt: 0,
							},
						},
					],
					now: 2000,
				},
				80,
				24,
			);
			for (const line of frame.lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(80);
			}
			expect(frame.lines.join("\n")).toContain("╭");
		} finally {
			setAmbiguousWide(undefined);
		}
	});

	it("uses ascii chrome when the glyph theme is ascii", () => {
		const frame = renderFrame({ ...base, glyphTheme: "ascii" }, 80, 24).join("\n");
		expect(frame).toContain("+--");
		expect(frame).toContain("| >");
		expect(frame).not.toContain("╭");
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

	it("inserts a palette command into the editor when candidates exist", async () => {
		const stdout = {
			write: () => true,
			columns: 60,
			rows: 12,
		} as unknown as NodeJS.WriteStream;
		const stdin = { isTTY: false, on() {}, off() {}, setRawMode() {} } as unknown as NodeJS.ReadStream;
		const tui = new InteractiveTui({
			stdin,
			stdout,
			completionCandidates: () => [{ token: "/status", description: "Show runtime status", kind: "command" }],
		});
		const prompt = tui.readPrompt();
		tui.pushKey({ type: "ctrl", value: "p" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		tui.pushKey({ type: "enter" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		tui.pushKey({ type: "enter" });
		await expect(prompt).resolves.toBe("/status");
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

	it("navigates slash completions with arrow keys and still submits", async () => {
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
				{ token: "/model", description: "Model settings", kind: "command" },
				{ token: "/new", description: "New conversation", kind: "command" },
				{ token: "/status", description: "Status", kind: "command" },
			],
		});
		const prompt = tui.readPrompt();
		tui.pushKey({ type: "char", value: "/" });
		tui.pushKey({ type: "down" });
		tui.pushKey({ type: "down" });
		tui.pushKey({ type: "up" });
		tui.pushKey({ type: "enter" });
		await expect(prompt).resolves.toBe("/new");

		const wrapped = tui.readPrompt();
		tui.pushKey({ type: "char", value: "/" });
		tui.pushKey({ type: "up" });
		tui.pushKey({ type: "enter" });
		await expect(wrapped).resolves.toBe("/status");
		tui.close();
	});

	it("keeps arrow-key history recall when no completion is open", async () => {
		const stdout = {
			write: () => true,
			columns: 80,
			rows: 24,
		} as unknown as NodeJS.WriteStream;
		const stdin = { isTTY: false, on() {}, off() {}, setRawMode() {} } as unknown as NodeJS.ReadStream;
		const tui = new InteractiveTui({
			stdin,
			stdout,
			completionCandidates: () => [{ token: "/model", description: "Model settings", kind: "command" }],
		});
		const first = tui.readPrompt();
		tui.pushKey({ type: "char", value: "plain text" });
		tui.pushKey({ type: "enter" });
		await expect(first).resolves.toBe("plain text");

		const recalled = tui.readPrompt();
		tui.pushKey({ type: "up" });
		tui.pushKey({ type: "enter" });
		await expect(recalled).resolves.toBe("plain text");
		tui.close();
	});

	it("scrolls the transcript with the mouse wheel in editor focus", async () => {
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
		const frame = () => screenText(writes);
		const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
		expect(frame()).toContain("old message 39");
		expect(frame()).not.toContain("old message 0");

		// Wheel events normalize into a scroll stream; residual lines flush on
		// the redraw cadence after the 80ms stream gap.
		tui.pushKey({ type: "wheelUp" });
		tui.pushKey({ type: "wheelUp" });
		await settle();
		expect(frame()).not.toContain("old message 39");

		tui.pushKey({ type: "wheelDown" });
		tui.pushKey({ type: "wheelDown" });
		await settle();
		expect(frame()).toContain("old message 39");
		tui.close();
	});

	it("moves the picker selection with the mouse wheel", async () => {
		const stdout = {
			write: () => true,
			columns: 80,
			rows: 24,
		} as unknown as NodeJS.WriteStream;
		const stdin = { isTTY: false, on() {}, off() {}, setRawMode() {} } as unknown as NodeJS.ReadStream;
		const tui = new InteractiveTui({ stdin, stdout });
		const pick = tui.pickFromList("Levels", ["off", "low", "high"], { initialIndex: 0 });
		tui.pushKey({ type: "wheelDown" });
		tui.pushKey({ type: "wheelDown" });
		tui.pushKey({ type: "wheelUp" });
		tui.pushKey({ type: "enter" });
		await expect(pick).resolves.toBe(1);
		tui.close();
	});

	it("pre-highlights a picker row with initialIndex", async () => {
		const stdout = {
			write: () => true,
			columns: 80,
			rows: 24,
		} as unknown as NodeJS.WriteStream;
		const stdin = { isTTY: false, on() {}, off() {}, setRawMode() {} } as unknown as NodeJS.ReadStream;
		const tui = new InteractiveTui({ stdin, stdout });
		const pick = tui.pickFromList("Thinking", ["off", "low", "high"], { initialIndex: 1 });
		tui.pushKey({ type: "down" });
		tui.pushKey({ type: "enter" });
		await expect(pick).resolves.toBe(2);
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

	it("re-renders streamed assistant markdown in place", () => {
		const writes: string[] = [];
		const stdout = {
			write: (chunk: string) => {
				writes.push(chunk);
				return true;
			},
			columns: 60,
			rows: 16,
		} as unknown as NodeJS.WriteStream;
		const stdin = { isTTY: false, on() {}, off() {}, setRawMode() {} } as unknown as NodeJS.ReadStream;
		const tui = new InteractiveTui({ stdin, stdout, colors: false });
		tui.appendAssistantDelta("# Hel");
		tui.appendAssistantDelta("lo\n\n**ok**");
		const frame = stripAnsi(writes[writes.length - 1] ?? "");
		expect(frame).toContain("# Hello");
		expect(frame).toContain("ok");
		expect(frame).not.toContain("**ok**");
		expect((frame.match(/# Hello/g) ?? []).length).toBe(1);
		tui.close();
	});

	it("forwards typed characters from transcript focus into the editor", async () => {
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
		tui.appendLine("some output");
		const prompt = tui.readPrompt();
		tui.pushKey({ type: "tab" }); // focus transcript
		tui.pushKey({ type: "char", value: "h" });
		tui.pushKey({ type: "char", value: "i" });
		tui.pushKey({ type: "enter" });
		await expect(prompt).resolves.toBe("hi");
		expect(screenText(writes)).toContain("enter send");
		tui.close();
	});

	it("PageUp scrolls the transcript without stealing editor focus", async () => {
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
			tui.appendLine(`line ${index}`);
		}
		const prompt = tui.readPrompt();
		tui.pushKey({ type: "char", value: "draft" });
		tui.pushKey({ type: "pageUp" });
		expect(screenText(writes)).not.toContain("line 39");
		// Focus stayed in the editor: typing continues the draft.
		tui.pushKey({ type: "char", value: "!" });
		tui.pushKey({ type: "enter" });
		await expect(prompt).resolves.toBe("draft!");
		tui.close();
	});

	it("selects a transcript entry on click and toggles the inspector on second click", () => {
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
		tui.appendToolStart("call-1", "read", { path: "a.ts" });
		tui.appendToolEnd("call-1", "file contents", false);
		const click = (col: number, row: number) => {
			tui.pushKey({
				type: "mouse",
				event: { kind: "down", button: "left", col, row, shift: false, alt: false, ctrl: false },
			});
			tui.pushKey({
				type: "mouse",
				event: { kind: "up", button: "left", col, row, shift: false, alt: false, ctrl: false },
			});
		};
		const toolRow = screenText(writes)
			.split("\n")
			.findIndex((line) => line.includes("read"));
		expect(toolRow).toBeGreaterThanOrEqual(2);
		click(5, toolRow);
		expect(screenText(writes).split("\n")[toolRow]).toContain(">");
		click(5, toolRow);
		expect(screenText(writes)).toContain("SUMMARY");
		tui.close();
	});

	it("positions the editor cursor on click", async () => {
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
		const prompt = tui.readPrompt();
		tui.pushKey({ type: "char", value: "hello" });
		// First editor content row: top border + first wrapped row, content starts
		// after the gutter (pipe, space, prompt, space).
		const editorRow = screenText(writes)
			.split("\n")
			.findIndex((line) => line.includes("hello"));
		expect(editorRow).toBeGreaterThanOrEqual(0);
		const col = (screenText(writes).split("\n")[editorRow] ?? "").indexOf("hello");
		tui.pushKey({
			type: "mouse",
			event: { kind: "down", button: "left", col, row: editorRow, shift: false, alt: false, ctrl: false },
		});
		tui.pushKey({
			type: "mouse",
			event: { kind: "up", button: "left", col, row: editorRow, shift: false, alt: false, ctrl: false },
		});
		tui.pushKey({ type: "char", value: ">" });
		tui.pushKey({ type: "enter" });
		await expect(prompt).resolves.toBe(">hello");
		tui.close();
	});

	it("Esc Esc clears a draft into the stash and ctrl+s restores it", async () => {
		const stdout = {
			write: () => true,
			columns: 80,
			rows: 24,
		} as unknown as NodeJS.WriteStream;
		const stdin = { isTTY: false, on() {}, off() {}, setRawMode() {} } as unknown as NodeJS.ReadStream;
		const tui = new InteractiveTui({ stdin, stdout, colors: false });
		void tui.readPrompt();
		tui.pushKey({ type: "char", value: "half typed" });
		tui.pushKey({ type: "escape" });
		tui.pushKey({ type: "escape" });
		// Draft gone: submitting now resolves nothing.
		tui.pushKey({ type: "ctrl", value: "s" });
		const restored = tui.readPrompt();
		tui.pushKey({ type: "enter" });
		await expect(restored).resolves.toBe("half typed");
		tui.close();
	});

	it("Esc Esc on an empty draft resolves the sessions picker", async () => {
		const stdout = {
			write: () => true,
			columns: 80,
			rows: 24,
		} as unknown as NodeJS.WriteStream;
		const stdin = { isTTY: false, on() {}, off() {}, setRawMode() {} } as unknown as NodeJS.ReadStream;
		const tui = new InteractiveTui({ stdin, stdout, colors: false });
		const first = tui.readPrompt();
		tui.pushKey({ type: "char", value: "hi" });
		tui.pushKey({ type: "enter" });
		await expect(first).resolves.toBe("hi");
		const second = tui.readPrompt();
		tui.pushKey({ type: "escape" });
		tui.pushKey({ type: "escape" });
		await expect(second).resolves.toBe("/sessions");
		tui.close();
	});

	it("moves the confirm choice focus with arrows and activates on enter", async () => {
		const stdout = {
			write: () => true,
			columns: 80,
			rows: 24,
		} as unknown as NodeJS.WriteStream;
		const stdin = { isTTY: false, on() {}, off() {}, setRawMode() {} } as unknown as NodeJS.ReadStream;
		const tui = new InteractiveTui({ stdin, stdout });
		const confirm = tui.confirmTool("bash", { command: "ls" });
		tui.pushKey({ type: "right" });
		tui.pushKey({ type: "right" });
		tui.pushKey({ type: "enter" });
		await expect(confirm).resolves.toBe("deny");

		const again = tui.confirmTool("bash", { command: "ls" });
		tui.pushKey({ type: "char", value: "2" });
		await expect(again).resolves.toBe("always");
		tui.close();
	});

	it("clicks a confirm choice", async () => {
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
		const confirm = tui.confirmTool("bash", { command: "rm -rf /tmp/x" });
		const rows = screenText(writes).split("\n");
		const choiceRow = rows.findIndex((line) => line.includes("[a] always"));
		expect(choiceRow).toBeGreaterThanOrEqual(0);
		const col = (rows[choiceRow] ?? "").indexOf("[a] always") + 1;
		tui.pushKey({
			type: "mouse",
			event: { kind: "down", button: "left", col, row: choiceRow, shift: false, alt: false, ctrl: false },
		});
		tui.pushKey({
			type: "mouse",
			event: { kind: "up", button: "left", col, row: choiceRow, shift: false, alt: false, ctrl: false },
		});
		await expect(confirm).resolves.toBe("always");
		tui.close();
	});

	it("wraps the picker with tab and clicks a row to choose", async () => {
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
		const wrap = tui.pickFromList("Levels", ["off", "low", "high"], { initialIndex: 2 });
		tui.pushKey({ type: "tab" }); // wraps 2 → 0
		tui.pushKey({ type: "enter" });
		await expect(wrap).resolves.toBe(0);

		const click = tui.pickFromList("Levels", ["off", "low", "high"]);
		const rows = screenText(writes).split("\n");
		const row = rows.findIndex((line) => line.includes("high"));
		expect(row).toBeGreaterThanOrEqual(0);
		tui.pushKey({
			type: "mouse",
			event: { kind: "down", button: "left", col: 4, row, shift: false, alt: false, ctrl: false },
		});
		tui.pushKey({
			type: "mouse",
			event: { kind: "up", button: "left", col: 4, row, shift: false, alt: false, ctrl: false },
		});
		await expect(click).resolves.toBe(2);
		tui.close();
	});

	it("jumps between user turns with shift+left/right in transcript focus", async () => {
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
		for (let turn = 0; turn < 3; turn += 1) {
			tui.appendUser(`question ${turn}`, false);
			tui.appendLine(`answer ${turn}`);
		}
		tui.pushKey({ type: "tab" }); // focus transcript; selection lands on last entry
		tui.pushKey({ type: "selectLeft" });
		const frame = screenText(writes);
		const selected = frame.split("\n").findIndex((line) => line.trimStart().startsWith(">"));
		expect(selected).toBeGreaterThanOrEqual(0);
		expect(frame.split("\n")[selected]).toContain("question 2");
		tui.pushKey({ type: "selectLeft" });
		expect(
			screenText(writes)
				.split("\n")
				.find((line) => line.trimStart().startsWith(">")),
		).toContain("question 1");
		tui.pushKey({ type: "selectRight" });
		expect(
			screenText(writes)
				.split("\n")
				.find((line) => line.trimStart().startsWith(">")),
		).toContain("question 2");
		tui.close();
	});

	it("retires the double-Esc clear gesture when another key intervenes", async () => {
		const stdout = {
			write: () => true,
			columns: 80,
			rows: 24,
		} as unknown as NodeJS.WriteStream;
		const stdin = { isTTY: false, on() {}, off() {}, setRawMode() {} } as unknown as NodeJS.ReadStream;
		const tui = new InteractiveTui({ stdin, stdout, colors: false });
		const prompt = tui.readPrompt();
		tui.pushKey({ type: "char", value: "draft" });
		tui.pushKey({ type: "escape" });
		// An intervening keypress retires the armed gesture: the next Esc is a
		// fresh arm, not the second half of a double-Esc.
		tui.pushKey({ type: "char", value: "!" });
		tui.pushKey({ type: "escape" });
		tui.pushKey({ type: "enter" });
		await expect(prompt).resolves.toBe("draft!");
		tui.close();
	});

	it("keeps the transcript viewport put when clicking an entry", () => {
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
			if (index === 25) {
				tui.appendToolStart("call-1", "read", { path: "a.ts" });
				tui.appendToolEnd("call-1", "file contents", false);
			} else {
				tui.appendLine(`line ${index}`);
			}
		}
		const click = (col: number, row: number) => {
			tui.pushKey({
				type: "mouse",
				event: { kind: "down", button: "left", col, row, shift: false, alt: false, ctrl: false },
			});
			tui.pushKey({
				type: "mouse",
				event: { kind: "up", button: "left", col, row, shift: false, alt: false, ctrl: false },
			});
		};
		const rows = () => screenText(writes).split("\n");
		const toolRow = rows().findIndex((line) => line.includes("read"));
		expect(toolRow).toBeGreaterThanOrEqual(2);
		click(10, toolRow);
		// Selecting must not recenter: the clicked row stays under the pointer.
		expect(rows()[toolRow]).toContain("read");
		expect(rows()[toolRow]).toContain(">");
		click(10, toolRow);
		expect(screenText(writes)).toContain("SUMMARY");
		tui.close();
	});

	it("lands the caret at row end when clicking past an editor line", async () => {
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
		const prompt = tui.readPrompt();
		tui.pushKey({ type: "char", value: "ab" });
		const editorRow = screenText(writes)
			.split("\n")
			.findIndex((line) => line.includes("ab"));
		expect(editorRow).toBeGreaterThanOrEqual(0);
		for (const kind of ["down", "up"] as const) {
			tui.pushKey({
				type: "mouse",
				event: { kind, button: "left", col: 30, row: editorRow, shift: false, alt: false, ctrl: false },
			});
		}
		tui.pushKey({ type: "char", value: "!" });
		tui.pushKey({ type: "enter" });
		await expect(prompt).resolves.toBe("ab!");
		tui.close();
	});

	it("close() is idempotent and writes LEAVE_ALT exactly once", () => {
		const writes: string[] = [];
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
			pause() {},
			setRawMode() {},
		} as unknown as NodeJS.ReadStream;
		const tui = new InteractiveTui({ stdin, stdout });
		tui.start();
		tui.close();
		tui.close();
		const output = writes.join("");
		expect(output.split(`${ESC}[?1049l`)).toHaveLength(2);
		expect(output).toContain(`${ESC}[?25h`);
	});
});

const ESC = "\u001b";
const ROW_WRITE = new RegExp(`^${ESC}\\[(\\d+);1H${ESC}\\[2K`);
const ROW_BOUNDARY = new RegExp(`(?=${ESC}\\[\\d+;1H)`, "u");

/** Replay LineScreen's diffed row writes into a reconstructed terminal frame. */
function screenText(writes: string[], rows = 40): string {
	const screen = new Map<number, string>();
	for (const chunk of writes) {
		for (const part of chunk.split(ROW_BOUNDARY)) {
			const match = ROW_WRITE.exec(part);
			if (match === null) {
				continue;
			}
			screen.set(Number(match[1]) - 1, stripAnsi(part.slice(match[0].length)));
		}
	}
	return Array.from({ length: rows }, (_, row) => screen.get(row) ?? "").join("\n");
}

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
