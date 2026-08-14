import { describe, expect, it } from "vitest";
import { confirmChoiceFromKey, formatConfirmPrompt } from "../src/confirm.ts";
import { EditorBuffer } from "../src/editor.ts";
import { parseKey } from "../src/keys.ts";
import { renderFrame } from "../src/layout.ts";
import { InteractiveTui } from "../src/session.ts";

describe("keys + editor + confirm", () => {
	it("parses enter, backspace, ctrl-c, arrows", () => {
		expect(parseKey("\r")).toEqual({ type: "enter" });
		expect(parseKey("\x7f")).toEqual({ type: "backspace" });
		expect(parseKey("\x03")).toEqual({ type: "ctrl", value: "c" });
		expect(parseKey("\x1b[A")).toEqual({ type: "up" });
		expect(parseKey("hi")).toEqual({ type: "char", value: "hi" });
	});

	it("edits and submits", () => {
		const editor = new EditorBuffer();
		editor.insert("ab");
		editor.backspace();
		editor.insert("c");
		expect(editor.submit()).toBe("ac");
		expect(editor.value).toBe("");
	});

	it("maps confirm keys", () => {
		expect(confirmChoiceFromKey({ type: "char", value: "y" })).toBe("once");
		expect(confirmChoiceFromKey({ type: "char", value: "a" })).toBe("always");
		expect(confirmChoiceFromKey({ type: "char", value: "n" })).toBe("deny");
		expect(formatConfirmPrompt({ toolName: "bash", args: { command: "ls" } })).toContain("bash");
	});
});

describe("renderFrame", () => {
	it("keeps status, body, editor, hint", () => {
		const lines = renderFrame(
			{
				status: "model=gpt cwd=/tmp",
				transcript: ["you: hi", "assistant:hello"],
				editorLines: [""],
				streaming: false,
			},
			40,
			8,
		);
		expect(lines[0]).toContain("model=gpt");
		expect(lines.some((line) => line.includes("assistant:hello"))).toBe(true);
		expect(lines[lines.length - 1]).toContain("Enter");
	});
});

describe("InteractiveTui", () => {
	it("resolves a prompt on enter and a confirm on y", async () => {
		const writes: string[] = [];
		const stdout = {
			write: (chunk: string) => {
				writes.push(chunk);
				return true;
			},
			columns: 40,
			rows: 10,
		} as unknown as NodeJS.WriteStream;
		const stdin = { isTTY: false, on() {}, off() {}, setRawMode() {} } as unknown as NodeJS.ReadStream;
		const tui = new InteractiveTui({ stdin, stdout, status: () => "test" });
		const prompt = tui.readPrompt();
		tui.pushKey({ type: "char", value: "go" });
		tui.pushKey({ type: "enter" });
		await expect(prompt).resolves.toBe("go");

		const confirm = tui.confirmTool("write", { path: "a.ts" });
		tui.pushKey({ type: "char", value: "y" });
		await expect(confirm).resolves.toBe("once");
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
});
