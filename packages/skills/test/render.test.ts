import { describe, expect, it } from "vitest";
import { formatActiveSkills, formatAvailableSkills, formatSkillInvocation, renderSkillContext } from "../src/index.ts";
import type { Budget, MatchResult, SkillDescriptor, SkillIdentity, SkillIndex, SkillState } from "../src/types.ts";

function skill(
	name: string,
	options: { description?: string; hidden?: boolean; displayPath?: string; body?: string; hash?: string } = {},
): SkillDescriptor {
	const canonicalPath = `/private/home/user/.pillow/skills/${name}/SKILL.md`;
	return {
		metadata: {
			name,
			description: options.description ?? `${name} description`,
			keywords: [],
			fileGlobs: [],
			allowedTools: [],
			disableModelInvocation: options.hidden ?? false,
			extra: {},
		},
		source: {
			scope: "user",
			kind: "conventional",
			rootDir: "/private/home/user/.pillow/skills",
			displayPath: options.displayPath ?? `~/.pillow/skills/${name}/SKILL.md`,
			canonicalPath,
		},
		baseDir: canonicalPath.slice(0, -"/SKILL.md".length),
		skillPath: canonicalPath,
		body: options.body,
		contentHash: options.hash ?? `${name}-hash`,
		diagnostics: [],
	};
}

function index(skills: readonly SkillDescriptor[]): SkillIndex {
	return {
		version: 2,
		skills,
		byName: new Map(skills.map((entry) => [entry.metadata.name.normalize("NFKC").toLowerCase(), entry])),
		diagnostics: [],
	};
}

function identity(entry: SkillDescriptor): SkillIdentity {
	return {
		name: entry.metadata.name,
		canonicalPath: entry.skillPath,
		contentHash: entry.contentHash!,
		sourceScope: entry.source.scope,
		sourceKind: entry.source.kind,
	};
}

function state(active: readonly SkillDescriptor[], mode: "progressive" | "full" | "index" = "progressive"): SkillState {
	return { active: active.map(identity), manualOffNames: [], mode, stale: [], diagnostics: [] };
}

const generous: Budget = {
	contextWindow: 100_000,
	baseContextTokens: 0,
	outputReserve: 0,
	safetyReserve: 0,
	estimator: (text) => text.length,
};

describe("skills context rendering", () => {
	it("escapes public metadata, includes read hints, and never exposes canonical paths", () => {
		const visible = skill("review", {
			description: `Use <review> & "verify"`,
			displayPath: `~/.pillow/skills/review & check/SKILL.md`,
		});
		const hidden = skill("hidden", { hidden: true });
		const result = formatAvailableSkills(index([visible, hidden]), generous);
		expect(result.text).toContain("<available_skills>");
		expect(result.text).toContain("Use &lt;review&gt; &amp; &quot;verify&quot;");
		expect(result.text).toContain("review &amp; check/SKILL.md");
		expect(result.text).toContain("skill_read skill=&quot;review&quot;");
		expect(result.text).not.toContain("/private/home/user");
		expect(result.text).not.toContain("hidden");
		expect(result.includedNames).toEqual(["review"]);

		const controls = formatAvailableSkills(
			index([skill("control", { description: "before\u0000after\u000Bdone" })]),
			generous,
		);
		expect(controls.text).toContain("before\uFFFDafter\uFFFDdone");
	});

	it("renders active hidden skills, omits stale identities, and includes full bodies only in full mode", () => {
		const hidden = skill("hidden", { hidden: true, body: "FULL <BODY>" });
		const stale = skill("stale", { body: "STALE BODY" });
		const activeState: SkillState = {
			...state([hidden], "full"),
			stale: [identity(stale)],
		};
		const full = formatActiveSkills(activeState, index([hidden, stale]), generous);
		expect(full.text).toContain("<active_skills>");
		expect(full.text).toContain("FULL &lt;BODY&gt;");
		expect(full.text).not.toContain("STALE BODY");

		const progressive = formatActiveSkills({ ...activeState, mode: "progressive" }, index([hidden]), generous);
		expect(progressive.text).toContain("hidden description");
		expect(progressive.text).not.toContain("FULL");
	});

	it("renders matched explanations and the explicit invocation body with request-only arguments", () => {
		const matchedSkill = skill("review", { body: "Review every line." });
		const matches: MatchResult = {
			matches: [
				{
					skill: matchedSkill,
					score: 80,
					reasons: ["name_overlap:80"],
					accepted: true,
				},
			],
			activations: [matchedSkill],
			diagnostics: [],
		};
		const combined = renderSkillContext(
			{
				index: index([matchedSkill]),
				state: state([matchedSkill], "full"),
				matches,
				explicitInvocation: { skill: matchedSkill, body: "Complete <instructions>.", args: "security & auth" },
			},
			generous,
		);
		expect(combined.text.indexOf("<available_skills>")).toBeLessThan(combined.text.indexOf("<active_skills>"));
		expect(combined.text.indexOf("<active_skills>")).toBeLessThan(combined.text.indexOf("<matched_skills>"));
		expect(combined.text).toContain("name_overlap:80");
		expect(combined.text).toContain("Complete &lt;instructions&gt;.");
		expect(combined.text).toContain("<user_instructions>security &amp; auth</user_instructions>");

		const invocation = formatSkillInvocation(matchedSkill, "whole body", "one < two", generous);
		expect(invocation.text).toContain("whole body");
		expect(invocation.text).toContain("<user_instructions>one &lt; two</user_instructions>");
		expect(invocation.includedNames).toEqual(["review"]);
	});
});

describe("skills token budget", () => {
	it("rejects invalid context windows with a configuration diagnostic", () => {
		const result = formatAvailableSkills(index([skill("review")]), {
			contextWindow: Number.NaN,
		});
		expect(result).toMatchObject({ text: "", estimatedTokens: 0, includedNames: [], omittedNames: ["review"] });
		expect(result.diagnostics[0]).toMatchObject({ code: "budget_exceeded", severity: "error" });
	});

	it("uses one shared 15% cap and allocates an explicit invocation before metadata", () => {
		const entry = skill("review");
		const invocation = formatSkillInvocation(entry, "body", "", generous);
		const contextWindow = Math.ceil((invocation.estimatedTokens + 2) / 0.15);
		const result = renderSkillContext(
			{
				index: index([entry]),
				state: state([]),
				explicitInvocation: { skill: entry, body: "body", args: "" },
			},
			{
				contextWindow,
				baseContextTokens: 0,
				outputReserve: 0,
				safetyReserve: 0,
				estimator: (text) => text.length,
			},
		);
		expect(result.text).toContain("<skill name=");
		expect(result.text).toContain("body");
		expect(result.text).not.toContain("<available_skills>");
		expect(result.estimatedTokens).toBeLessThanOrEqual(Math.floor(contextWindow * 0.15));
		expect(result.diagnostics.some(({ code }) => code === "budget_exceeded")).toBe(true);
	});

	it("includes or omits each serialized entry and body as a whole", () => {
		const tooLarge = skill("large", { description: "x".repeat(2_000) });
		const small = skill("small", { description: "short" });
		const result = formatAvailableSkills(index([tooLarge, small]), {
			contextWindow: 4_000,
			baseContextTokens: 0,
			outputReserve: 0,
			safetyReserve: 0,
			estimator: (text) => text.length,
		});
		expect(result.omittedNames).toContain("large");
		expect(result.includedNames).toContain("small");
		expect(result.text).not.toContain("x".repeat(20));
		expect(result.estimatedTokens).toBeLessThanOrEqual(600);
	});

	it("subtracts base, output, and safety reserves from the skills allowance", () => {
		const result = formatAvailableSkills(index([skill("review")]), {
			contextWindow: 1_000,
			baseContextTokens: 900,
			outputReserve: 60,
			safetyReserve: 40,
			estimator: () => 1,
		});
		expect(result.text).toBe("");
		expect(result.omittedNames).toEqual(["review"]);
	});

	it("falls back conservatively when a custom estimator throws or returns invalid values", () => {
		const entry = skill("review");
		for (const estimator of [
			() => {
				throw new Error("broken");
			},
			() => Number.NaN,
		]) {
			const result = formatAvailableSkills(index([entry]), {
				contextWindow: 100_000,
				outputReserve: 0,
				safetyReserve: 0,
				estimator,
			});
			expect(result.includedNames).toEqual(["review"]);
			expect(result.estimatedTokens).toBeGreaterThan(0);
		}
	});
});
