import { describe, expect, it } from "vitest";
import { parseKeymapConfig, resolveAction } from "../src/keymap.ts";

const editor = { completion: false, focus: "editor" as const, modal: false, streaming: false };

describe("keymap", () => {
	it("keeps interrupt on ctrl+c and warns on illegal rebinds", () => {
		const parsed = parseKeymapConfig({
			interrupt: "ctrl+x",
			palette: "ctrl+k",
			unknown: "ctrl+a",
			submit: "not-a-key",
		});
		expect(parsed.warnings.some((warning) => warning.includes("interrupt"))).toBe(true);
		expect(parsed.warnings.some((warning) => warning.includes("unknown"))).toBe(true);
		expect(parsed.warnings.some((warning) => warning.includes("submit"))).toBe(true);
		expect(resolveAction({ type: "ctrl", value: "c" }, parsed.bindings, { ...editor, streaming: true })).toBe(
			"interrupt",
		);
		expect(resolveAction({ type: "ctrl", value: "k" }, parsed.bindings, editor)).toBe("palette");
	});

	it("prefers completion and inspector actions by focus", () => {
		const parsed = parseKeymapConfig(undefined);
		expect(resolveAction({ type: "tab" }, parsed.bindings, { ...editor, completion: true })).toBe(
			"completion.accept",
		);
		expect(resolveAction({ type: "tab" }, parsed.bindings, editor)).toBe("focus.transcript");
		expect(resolveAction({ type: "enter" }, parsed.bindings, { ...editor, focus: "transcript" })).toBe(
			"inspector.toggle",
		);
		expect(resolveAction({ type: "enter" }, parsed.bindings, editor)).toBe("submit");
	});
});
