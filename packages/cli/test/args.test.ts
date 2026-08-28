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

	it("recognizes catalog and session listing commands", () => {
		const args = parseArgs(["--list-models", "--list-sessions"]);
		expect(args.listModels).toBe(true);
		expect(args.listSessions).toBe(true);
	});

	it("rejects unknown flags", () => {
		expect(parseArgs(["--bogus"]).error).toBe("Unknown flag: --bogus");
	});

	it("parses context window and max token flags", () => {
		const args = parseArgs(["--context-window", "200000", "--max-tokens", "8192"]);
		expect(args.contextWindow).toBe(200_000);
		expect(args.maxTokens).toBe(8_192);
		expect(parseArgs(["--context-window", "0"]).error).toBe("Invalid value for --context-window");
		expect(parseArgs(["--context-window", "12345678901234567890"]).error).toBe("Invalid value for --context-window");
		expect(parseArgs(["--max-tokens"]).error).toBe("Missing value for --max-tokens");
	});
});

describe("looksLikeReasoningModel / resolveModelId / help", () => {
	it("flags gpt-5", () => {
		expect(looksLikeReasoningModel("gpt-5.4")).toBe(true);
		expect(looksLikeReasoningModel("gpt-4.1-mini")).toBe(false);
	});

	it("resolves model id", () => {
		expect(resolveModelId({ ...parseArgs([]), model: "from-flag" }, { OPENAI_MODEL: "from-env" })).toBe("from-flag");
		expect(resolveModelId(parseArgs([]), { OPENAI_MODEL: "from-env" })).toBe("from-env");
		expect(resolveModelId(parseArgs([]), {})).toBeUndefined();
	});

	it("help mentions TUI and jail", () => {
		const lines: string[] = [];
		printHelp((text) => {
			lines.push(text);
		});
		const help = lines.join("");
		expect(help).toContain("Usage:");
		expect(help).toContain("OPENAI_API_KEY");
		expect(help).toContain("config.json");
		expect(help).toContain("TUI");
		expect(help).toContain("--no-jail");
		expect(help).toContain("--list-models");
		expect(help).toContain("--context-window");
		expect(help).toContain("--max-tokens");
		expect(help).toContain("OPENAI_CONTEXT_WINDOW");
	});
});
