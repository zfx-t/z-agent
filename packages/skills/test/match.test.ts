import { describe, expect, it } from "vitest";
import { matchSkills } from "../src/index.ts";
import type { SkillDescriptor, SkillIndex, SkillSource } from "../src/types.ts";

const source = (
	scope: "user" | "project" = "user",
	kind: "manifest" | "conventional" = "conventional",
): SkillSource => ({
	scope,
	kind,
	rootDir: "/skills",
	displayPath: `~/.pillow/skills/${scope}-${kind}/SKILL.md`,
	canonicalPath: `/private/${scope}-${kind}/SKILL.md`,
});

function skill(
	name: string,
	options: {
		description?: string;
		keywords?: string[];
		fileGlobs?: string[];
		hidden?: boolean;
		scope?: "user" | "project";
		kind?: "manifest" | "conventional";
		path?: string;
	} = {},
): SkillDescriptor {
	const skillSource = source(options.scope, options.kind);
	const path = options.path ?? `/private/${name}/SKILL.md`;
	return {
		metadata: {
			name,
			description: options.description ?? "unrelated",
			keywords: options.keywords ?? [],
			fileGlobs: options.fileGlobs ?? [],
			allowedTools: [],
			disableModelInvocation: options.hidden ?? false,
			extra: {},
		},
		source: { ...skillSource, canonicalPath: path },
		baseDir: path.slice(0, -"/SKILL.md".length),
		skillPath: path,
		diagnostics: [],
	};
}

function index(skills: readonly SkillDescriptor[]): SkillIndex {
	return {
		version: 3,
		skills,
		byName: new Map(skills.map((entry) => [entry.metadata.name.normalize("NFKC").toLowerCase(), entry])),
		diagnostics: [],
	};
}

describe("matchSkills", () => {
	it("scores every deterministic signal with the specified caps", () => {
		const exact = skill("code-review");
		expect(matchSkills({ text: "Please CODE review this" }, index([exact])).matches[0]?.score).toBe(100);

		const nameOverlap = skill("alpha-beta-gamma");
		expect(matchSkills({ text: "alpha beta" }, index([nameOverlap])).matches[0]).toMatchObject({ score: 80 });

		const keywords = skill("other", { keywords: ["secure", "regression", "unused"] });
		expect(matchSkills({ text: "secure regression" }, index([keywords])).matches[0]).toMatchObject({ score: 60 });

		const description = skill("other", { description: "one two three four five six" });
		expect(matchSkills({ text: "one two three four five six" }, index([description])).matches[0]).toMatchObject({
			score: 30,
			exclusion: "threshold",
		});

		const paths = skill("other", { fileGlobs: ["**/*.ts", "src/**", "**/*"] });
		expect(matchSkills({ text: "unmatched", pathHints: ["src/index.ts"] }, index([paths])).matches[0]).toMatchObject({
			score: 70,
			accepted: true,
		});
	});

	it("normalizes Unicode NFKC and lowercases tokens", () => {
		const result = matchSkills({ text: "ＦＯＯ bar" }, index([skill("foo-bar")]));
		expect(result.matches[0]).toMatchObject({ score: 100, accepted: true });
		expect(result.matches[0]?.reasons).toContain("exact_name_phrase:100");
	});

	it("excludes hidden, stale, and manually disabled candidates", () => {
		const skills = [skill("hidden", { hidden: true }), skill("stale"), skill("manual")];
		const result = matchSkills(
			{
				text: "hidden stale manual",
				staleNames: ["STALE"],
				manualOffNames: ["ＭＡＮＵＡＬ"],
			},
			index(skills),
		);
		expect(Object.fromEntries(result.matches.map((match) => [match.skill.metadata.name, match.exclusion]))).toEqual({
			hidden: "hidden",
			stale: "stale",
			manual: "manual_off",
		});
		expect(result.activations).toEqual([]);
	});

	it("keeps active matches accepted without counting them against activation caps", () => {
		const skills = [skill("already"), skill("first"), skill("second")];
		const result = matchSkills({ text: "already first second", activeNames: ["already"] }, index(skills), {
			maxNew: 1,
			maxActive: 8,
		});
		expect(result.matches.find((entry) => entry.skill.metadata.name === "already")).toMatchObject({ accepted: true });
		expect(result.activations.map((entry) => entry.metadata.name)).toEqual(["first"]);
		expect(result.matches.find((entry) => entry.skill.metadata.name === "second")?.exclusion).toBe("turn_limit");
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0]).toMatchObject({ code: "activation_limit", skillName: "second" });
	});

	it("enforces the session cap before the turn cap", () => {
		const result = matchSkills({ text: "new-skill", activeNames: ["a", "b"] }, index([skill("new-skill")]), {
			maxNew: 2,
			maxActive: 2,
		});
		expect(result.matches[0]).toMatchObject({ accepted: false, exclusion: "session_limit" });
		expect(result.diagnostics[0]?.message).toContain("session limit (2)");
	});

	it("sorts ties by source rank, normalized name, then canonical path", () => {
		const skills = [
			skill("zeta", { keywords: ["topic"], scope: "user", kind: "conventional" }),
			skill("beta", { keywords: ["topic"], scope: "project", kind: "conventional" }),
			skill("alpha", { keywords: ["topic"], scope: "project", kind: "manifest", path: "/z/SKILL.md" }),
			skill("alpha-2", { keywords: ["topic"], scope: "project", kind: "manifest", path: "/a/SKILL.md" }),
		];
		const result = matchSkills({ text: "topic" }, index(skills), { maxNew: 4 });
		expect(result.matches.map((entry) => entry.skill.metadata.name)).toEqual(["alpha", "alpha-2", "beta", "zeta"]);
	});
});
