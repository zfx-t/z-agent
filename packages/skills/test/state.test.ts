import { describe, expect, it } from "vitest";
import { reconcileSkillState, reduceSkillState } from "../src/index.ts";
import type {
	SkillActivationNode,
	SkillDeactivationNode,
	SkillDescriptor,
	SkillIndex,
	SkillModeNode,
	SkillState,
} from "../src/types.ts";

let sequence = 0;

function activation(name: string, overrides: Partial<SkillActivationNode> = {}): SkillActivationNode {
	sequence += 1;
	return {
		type: "skill_activation",
		schemaVersion: 1,
		id: `a-${sequence}`,
		parentId: null,
		createdAt: sequence,
		skillName: name,
		canonicalPath: `/skills/${name}/SKILL.md`,
		sourceScope: "user",
		sourceKind: "conventional",
		contentHash: `${name}-hash`,
		origin: "automatic",
		...overrides,
	};
}

function deactivation(name: string, overrides: Partial<SkillDeactivationNode> = {}): SkillDeactivationNode {
	sequence += 1;
	return {
		type: "skill_deactivation",
		schemaVersion: 1,
		id: `d-${sequence}`,
		parentId: null,
		createdAt: sequence,
		skillName: name,
		origin: "command",
		...overrides,
	};
}

function mode(value: "progressive" | "full" | "index"): SkillModeNode {
	sequence += 1;
	return {
		type: "skill_mode",
		schemaVersion: 1,
		id: `m-${sequence}`,
		parentId: null,
		createdAt: sequence,
		mode: value,
	};
}

function descriptor(
	name: string,
	path = `/skills/${name}/SKILL.md`,
	hash: string | null = `${name}-hash`,
): SkillDescriptor {
	return {
		metadata: {
			name,
			description: name,
			keywords: [],
			fileGlobs: [],
			allowedTools: [],
			disableModelInvocation: false,
			extra: {},
		},
		source: {
			scope: "user",
			kind: "conventional",
			rootDir: "/skills",
			displayPath: `~/.pillow/skills/${name}/SKILL.md`,
			canonicalPath: path,
		},
		baseDir: path.slice(0, -"/SKILL.md".length),
		skillPath: path,
		contentHash: hash ?? undefined,
		diagnostics: [],
	};
}

function index(skills: readonly SkillDescriptor[]): SkillIndex {
	return {
		version: 9,
		skills,
		byName: new Map(skills.map((entry) => [entry.metadata.name, entry])),
		diagnostics: [],
	};
}

describe("reduceSkillState", () => {
	it("replays branch-local nodes and defaults empty branches", () => {
		const nodes = [activation("review"), mode("full"), activation("write")];
		expect(reduceSkillState([])).toEqual({
			active: [],
			manualOffNames: [],
			mode: "progressive",
			stale: [],
			diagnostics: [],
		});
		expect(reduceSkillState(nodes.slice(0, 2))).toMatchObject({
			active: [{ name: "review" }],
			mode: "full",
		});
		expect(reduceSkillState(nodes)).toMatchObject({
			active: [{ name: "review" }, { name: "write" }],
			mode: "full",
		});
	});

	it("records manual-off and clears it only on explicit activation", () => {
		const result = reduceSkillState([
			activation("review"),
			deactivation("review"),
			activation("review", { origin: "automatic" }),
		]);
		expect(result.active).toEqual([]);
		expect(result.manualOffNames).toEqual(["review"]);

		const accepted = reduceSkillState([
			activation("review"),
			deactivation("review"),
			activation("review", { origin: "explicit", contentHash: "accepted" }),
		]);
		expect(accepted.active[0]).toMatchObject({ name: "review", contentHash: "accepted" });
		expect(accepted.manualOffNames).toEqual([]);
	});

	it("uses canonical paths for targeted deactivation and replaces duplicate activation", () => {
		const result = reduceSkillState([
			activation("review", { canonicalPath: "/old/SKILL.md" }),
			deactivation("review", { canonicalPath: "/different/SKILL.md", origin: "reload" }),
			activation("review", { canonicalPath: "/new/SKILL.md", contentHash: "new", origin: "explicit" }),
		]);
		expect(result.active).toEqual([
			{
				name: "review",
				canonicalPath: "/new/SKILL.md",
				contentHash: "new",
				sourceScope: "user",
				sourceKind: "conventional",
			},
		]);
	});

	it("retains reload removals as stale audit state and reset clears all skill state", () => {
		const stale = reduceSkillState([
			activation("review"),
			mode("full"),
			deactivation("review", { origin: "reload" }),
		]);
		expect(stale).toMatchObject({ active: [], stale: [{ name: "review" }], mode: "full" });

		const reset = reduceSkillState([
			activation("review"),
			deactivation("other"),
			mode("index"),
			deactivation("*", { origin: "reset" }),
		]);
		expect(reset).toMatchObject({ active: [], stale: [], manualOffNames: [], mode: "progressive" });

		const disabledStale = reduceSkillState([
			activation("review"),
			deactivation("review", { origin: "reload" }),
			deactivation("review", { canonicalPath: "/skills/review/SKILL.md", origin: "command" }),
		]);
		expect(disabledStale).toMatchObject({ active: [], stale: [], manualOffNames: ["review"] });
	});

	it("reports and ignores malformed persisted controls", () => {
		const malformed = { ...activation("review"), contentHash: "" } as SkillActivationNode;
		const state = reduceSkillState([malformed]);
		expect(state.active).toEqual([]);
		expect(state.diagnostics[0]).toMatchObject({ code: "invalid_metadata", skillName: "review" });

		const forgedReset = deactivation("review", { origin: "reset" });
		const retained = reduceSkillState([activation("review"), forgedReset]);
		expect(retained.active).toHaveLength(1);
		expect(retained.diagnostics.at(-1)).toMatchObject({ code: "invalid_metadata", skillName: "review" });
	});
});

describe("reconcileSkillState", () => {
	const baseState: SkillState = {
		active: [
			{
				name: "ok",
				canonicalPath: "/skills/ok/SKILL.md",
				contentHash: "ok-hash",
				sourceScope: "user",
				sourceKind: "conventional",
			},
			{
				name: "changed",
				canonicalPath: "/skills/changed/SKILL.md",
				contentHash: "old",
				sourceScope: "user",
				sourceKind: "conventional",
			},
			{
				name: "rebound",
				canonicalPath: "/old/rebound/SKILL.md",
				contentHash: "rebound-hash",
				sourceScope: "user",
				sourceKind: "conventional",
			},
			{
				name: "missing",
				canonicalPath: "/skills/missing/SKILL.md",
				contentHash: "missing-hash",
				sourceScope: "user",
				sourceKind: "conventional",
			},
			{
				name: "unhashed",
				canonicalPath: "/skills/unhashed/SKILL.md",
				contentHash: "unhashed-hash",
				sourceScope: "user",
				sourceKind: "conventional",
			},
		],
		manualOffNames: ["manual"],
		mode: "full",
		stale: [],
		diagnostics: [],
	};

	it("requires exact name, canonical path, and content hash without rebinding", () => {
		const reconciled = reconcileSkillState(
			baseState,
			index([
				descriptor("ok"),
				descriptor("changed", undefined, "new"),
				descriptor("rebound", "/new/rebound/SKILL.md"),
				descriptor("unhashed", undefined, null),
			]),
		);
		expect(reconciled.active.map(({ name }) => name)).toEqual(["ok"]);
		expect(reconciled.stale.map(({ name }) => name)).toEqual(["changed", "rebound", "missing", "unhashed"]);
		expect(reconciled.diagnostics.map(({ code }) => code)).toEqual([
			"body_changed",
			"body_changed",
			"body_missing",
			"body_missing",
		]);
		expect(reconciled).toMatchObject({ manualOffNames: ["manual"], mode: "full" });
	});

	it("never automatically restores identities already marked stale", () => {
		const stale = { ...baseState.active[0]! };
		const reconciled = reconcileSkillState({ ...baseState, active: [], stale: [stale] }, index([descriptor("ok")]));
		expect(reconciled.active).toEqual([]);
		expect(reconciled.stale).toEqual([stale]);
	});
});
