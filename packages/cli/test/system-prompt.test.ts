import { describe, expect, it } from "vitest";
import { buildCodingSystemPrompt } from "../src/system-prompt.ts";

describe("buildCodingSystemPrompt", () => {
	it("includes cwd, seven tools, and jail", () => {
		const prompt = buildCodingSystemPrompt("/tmp/work", true);
		expect(prompt).toContain("/tmp/work");
		expect(prompt).toContain("grep");
		expect(prompt).toContain("jail is on");
		expect(buildCodingSystemPrompt("/tmp/work", false)).toContain("jail is off");
	});
});
