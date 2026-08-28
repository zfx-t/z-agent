import { describe, expect, it } from "vitest";
import { parseSkill } from "../src/index.ts";
import type { SkillSource } from "../src/types.ts";

const source: SkillSource = {
	scope: "project",
	kind: "conventional",
	rootDir: "/repo/.pillow/skills",
	displayPath: ".pillow/skills/review/SKILL.md",
	canonicalPath: "/repo/.pillow/skills/review/SKILL.md",
};

function document(frontmatter: string, body = "# Instructions\nReview carefully.\n"): string {
	return `---\n${frontmatter}\n---\n${body}`;
}

describe("parseSkill", () => {
	it("parses and normalizes supported frontmatter without losing extensions", () => {
		const result = parseSkill(
			document(`name: code-review
description: Review code for correctness and regressions.
license: MIT
compatibility: Node.js 22+
metadata:
  keywords: [review, security]
  file-globs: ["**/*.ts", "**/*.tsx"]
  owner: platform
allowed-tools: read grep
disable-model-invocation: true
x-product-field: retained`),
			source,
		);

		expect(result.diagnostics).toEqual([]);
		expect(result.descriptor).toMatchObject({
			baseDir: "/repo/.pillow/skills/review",
			skillPath: source.canonicalPath,
			body: "# Instructions\nReview carefully.\n",
			metadata: {
				name: "code-review",
				description: "Review code for correctness and regressions.",
				license: "MIT",
				compatibility: "Node.js 22+",
				keywords: ["review", "security"],
				fileGlobs: ["**/*.ts", "**/*.tsx"],
				allowedTools: ["read", "grep"],
				disableModelInvocation: true,
				extra: {
					metadata: { owner: "platform" },
					"x-product-field": "retained",
				},
			},
		});
	});

	it("accepts allowed-tools arrays and warns while dropping invalid optional values", () => {
		const result = parseSkill(
			document(`name: test-helper
description: Help write focused tests.
metadata:
  keywords: [tests, 3, "", focused]
  file-globs: ["**/*.test.ts", false, "", "[unterminated"]
allowed-tools: [read, 7, grep]
disable-model-invocation: yes
license: 42`),
			source,
		);

		expect(result.descriptor?.metadata).toMatchObject({
			keywords: ["tests", "focused"],
			fileGlobs: ["**/*.test.ts"],
			allowedTools: ["read", "grep"],
			disableModelInvocation: false,
		});
		expect(result.diagnostics.length).toBeGreaterThanOrEqual(4);
		expect(result.diagnostics.every((item) => item.code === "invalid_metadata")).toBe(true);
		expect(result.diagnostics.every((item) => item.severity === "warning")).toBe(true);
	});

	it.each([
		["missing name", "description: present"],
		["missing description", "name: valid-name"],
		["invalid name", "name: Invalid--Name\ndescription: present"],
		["oversized description", `name: valid-name\ndescription: ${"x".repeat(1025)}`],
	])("rejects %s", (_label, frontmatter) => {
		const result = parseSkill(document(frontmatter), source);
		expect(result.descriptor).toBeUndefined();
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({ code: "invalid_metadata", severity: "error" }),
		);
	});

	it("does not infer metadata from a legacy Markdown heading", () => {
		const result = parseSkill("# Legacy skill\nDo something.\n", source);
		expect(result.descriptor).toBeUndefined();
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({ code: "invalid_frontmatter", severity: "error" }),
		);
	});

	it("bounds frontmatter bytes, YAML depth, collection size, and aliases", () => {
		const tooLarge = parseSkill(`---\nname: safe-name\ndescription: ${"x".repeat(70 * 1024)}\n---\nbody`, source);
		const tooDeep = parseSkill(
			document(`name: safe-name\ndescription: safe\nextra: ${"[".repeat(40)}value${"]".repeat(40)}`),
			source,
		);
		const tooMany = parseSkill(
			document(
				`name: safe-name\ndescription: safe\nmetadata:\n  keywords: [${Array.from({ length: 300 }, (_, index) => `k${index}`).join(", ")}]`,
			),
			source,
		);
		const alias = parseSkill(
			document("name: safe-name\ndescription: safe\nmetadata: &metadata { keywords: [safe] }\ncopy: *metadata"),
			source,
		);

		for (const result of [tooLarge, tooDeep, tooMany, alias]) {
			expect(result.descriptor).toBeUndefined();
			expect(result.diagnostics).toContainEqual(
				expect.objectContaining({ code: "invalid_frontmatter", severity: "error" }),
			);
		}
	});

	it("turns malformed YAML into a diagnostic instead of throwing", () => {
		expect(() => parseSkill(document("name: [unterminated"), source)).not.toThrow();
		expect(parseSkill(document("name: [unterminated"), source).descriptor).toBeUndefined();
	});
});
