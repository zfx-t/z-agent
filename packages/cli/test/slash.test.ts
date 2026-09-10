import { describe, expect, it } from "vitest";
import { INTERACTIVE_COMMANDS } from "../src/interactive-commands.ts";
import { parseSlashInput, type SlashSkillIndex } from "../src/slash.ts";

function index(...names: string[]): SlashSkillIndex {
	return {
		byName: new Map(names.map((name) => [name, { metadata: { name } }])),
	};
}

describe("parseSlashInput", () => {
	it("gives built-in commands precedence over a same-named skill", () => {
		expect(parseSlashInput("/reload", index("reload"), INTERACTIVE_COMMANDS)).toEqual({
			kind: "builtin",
			name: "/reload",
			args: "",
		});
	});

	it("parses direct skill invocation and preserves request-only arguments", () => {
		expect(parseSlashInput("/code-review security only", index("code-review"))).toEqual({
			kind: "skill",
			name: "code-review",
			args: "security only",
			explicit: true,
		});
	});

	it("normalizes direct skill names consistently with the long form", () => {
		expect(parseSlashInput("/ＲＥＶＩＥＷ now", index("review"))).toEqual({
			kind: "skill",
			name: "review",
			args: "now",
			explicit: true,
		});
	});

	it("recognizes skill management commands", () => {
		expect(parseSlashInput("/skill code-review security", index("code-review"))).toEqual({
			kind: "builtin",
			name: "/skill",
			args: "code-review security",
		});
		expect(parseSlashInput("/skill -code-review", index("code-review"))).toEqual({
			kind: "builtin",
			name: "/skill",
			args: "-code-review",
		});
		expect(parseSlashInput("/skill all", index("code-review"))).toEqual({
			kind: "builtin",
			name: "/skill",
			args: "all",
		});
		expect(parseSlashInput("/skills mode full", index())).toEqual({
			kind: "builtin",
			name: "/skills",
			args: "mode full",
		});
		expect(parseSlashInput("/skills model", index())).toEqual({
			kind: "builtin",
			name: "/skills",
			args: "model",
		});
	});

	it("returns command errors for malformed recognized skill commands", () => {
		expect(parseSlashInput("/skill", index())).toEqual({
			kind: "error",
			message: "Usage: /skill <name> [args], /skill -<name>, or /skill all",
		});
		expect(parseSlashInput("/skills mode invalid", index())).toEqual({
			kind: "error",
			message: "Usage: /skills mode progressive|full|index",
		});
	});

	it("treats /model as a builtin and validates args", () => {
		expect(parseSlashInput("/model", index())).toEqual({ kind: "builtin", name: "/model", args: "" });
		expect(parseSlashInput("/model context 200000", index())).toEqual({
			kind: "builtin",
			name: "/model",
			args: "context 200000",
		});
		expect(parseSlashInput("/model context 0", index())).toEqual({
			kind: "error",
			message:
				"Usage: /model, /model context <n>, /model max-tokens <n>, or /model thinking off|minimal|low|medium|high|xhigh|max",
		});
	});

	it("canonicalizes built-in aliases", () => {
		expect(parseSlashInput("/quit", index())).toEqual({ kind: "builtin", name: "/exit", args: "" });
		expect(parseSlashInput("/help", index())).toEqual({ kind: "builtin", name: "/commands", args: "" });
		expect(parseSlashInput("/resume", index())).toEqual({ kind: "builtin", name: "/sessions", args: "" });
	});

	it("passes unknown slash input through as ordinary user text", () => {
		expect(parseSlashInput("/unknown keep this", index("code-review"))).toEqual({
			kind: "text",
			text: "/unknown keep this",
		});
		expect(parseSlashInput("ordinary prompt", index())).toEqual({
			kind: "text",
			text: "ordinary prompt",
		});
	});
});
