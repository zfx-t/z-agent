import { describe, expect, it } from "vitest";
import { looksLikeReasoningModel, parseArgs, printHelp, resolveModelId } from "../src/args.ts";

describe("parseArgs", () => {
	it("collects prompt words and flags", () => {
		const args = parseArgs([
			"--verbose",
			"--yes",
			"--no-jail",
			"-p",
			"--cwd",
			"/tmp/p",
			"--model",
			"gpt-4.1-mini",
			"fix",
			"it",
		]);
		expect(args.verbose).toBe(true);
		expect(args.yes).toBe(true);
		expect(args.noJail).toBe(true);
		expect(args.print).toBe(true);
		expect(args.cwd).toBe("/tmp/p");
		expect(args.model).toBe("gpt-4.1-mini");
		expect(args.promptParts).toEqual(["fix", "it"]);
	});

	it("rejects unknown flags", () => {
		expect(parseArgs(["--bogus"]).error).toBe("Unknown flag: --bogus");
	});
});

describe("looksLikeReasoningModel / resolveModelId / help", () => {
	it("flags gpt-5", () => {
		expect(looksLikeReasoningModel("gpt-5.4")).toBe(true);
		expect(looksLikeReasoningModel("gpt-4.1-mini")).toBe(false);
	});

	it("resolves model id", () => {
		expect(resolveModelId({ ...parseArgs([]), model: "from-flag" }, { OPENAI_MODEL: "from-env" })).toBe("from-flag");
		expect(resolveModelId(parseArgs([]), {})).toBe("gpt-4.1-mini");
	});

	it("help mentions TUI and jail", () => {
		const lines: string[] = [];
		printHelp((text) => {
			lines.push(text);
		});
		const help = lines.join("");
		expect(help).toContain("Usage:");
		expect(help).toContain("OPENAI_API_KEY");
		expect(help).toContain("TUI");
		expect(help).toContain("--no-jail");
	});
});
