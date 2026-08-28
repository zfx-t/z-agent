import { describe, expect, it } from "vitest";
import { resolveSkillConflicts } from "../src/index.ts";
import type { SkillDescriptor, SkillDiagnostic, SkillScope, SkillSourceKind } from "../src/types.ts";

function descriptor(
	name: string,
	scope: SkillScope,
	kind: SkillSourceKind,
	path: string,
	diagnostics: readonly SkillDiagnostic[] = [],
): SkillDescriptor {
	return {
		metadata: {
			name,
			description: `${name} description`,
			keywords: [],
			fileGlobs: [],
			allowedTools: [],
			disableModelInvocation: false,
			extra: {},
		},
		source: {
			scope,
			kind,
			rootDir: "/skills",
			displayPath: path,
			canonicalPath: path,
		},
		baseDir: path.slice(0, path.lastIndexOf("/")),
		skillPath: path,
		diagnostics,
	};
}

describe("resolveSkillConflicts", () => {
	it("uses the exact project/manifest precedence independent of input order", () => {
		const candidates = [
			descriptor("review", "user", "conventional", "/user/conventional/SKILL.md"),
			descriptor("review", "project", "conventional", "/project/conventional/SKILL.md"),
			descriptor("review", "user", "manifest", "/user/manifest/SKILL.md"),
			descriptor("review", "project", "manifest", "/project/manifest/SKILL.md"),
		];

		const forward = resolveSkillConflicts(candidates);
		const reverse = resolveSkillConflicts(candidates.slice().reverse());

		expect(forward.index.byName.get("review")?.source).toMatchObject({
			scope: "project",
			kind: "manifest",
		});
		expect(reverse.index.byName.get("review")?.source.canonicalPath).toBe(
			forward.index.byName.get("review")?.source.canonicalPath,
		);
		expect(reverse.diagnostics).toEqual(forward.diagnostics);
	});

	it("deduplicates canonical paths before reporting distinct-path name collisions", () => {
		const path = "/shared/review/SKILL.md";
		const result = resolveSkillConflicts([
			descriptor("review", "user", "conventional", path),
			descriptor("review", "project", "manifest", path),
			descriptor("review", "project", "conventional", "/project/review/SKILL.md"),
		]);

		expect(result.index.skills).toHaveLength(1);
		expect(result.index.byName.get("review")?.source).toMatchObject({
			scope: "project",
			kind: "manifest",
		});
		expect(result.diagnostics.filter((item) => item.code === "duplicate_path")).toHaveLength(1);
		expect(result.diagnostics.filter((item) => item.code === "name_collision")).toHaveLength(1);
	});

	it("normalizes lookup names, preserves metadata, aggregates diagnostics, and freezes index containers", () => {
		const inputDiagnostic: SkillDiagnostic = {
			code: "invalid_metadata",
			severity: "warning",
			message: "retained warning",
		};
		const fullWidthName = "ＲＥＶＩＥＷ";
		const result = resolveSkillConflicts(
			[descriptor(fullWidthName, "user", "manifest", "/user/review/SKILL.md", [inputDiagnostic])],
			{ version: 7 },
		);

		expect(result.index.version).toBe(7);
		expect(result.index.byName.get("review")?.metadata.name).toBe(fullWidthName);
		expect(result.diagnostics).toContain(inputDiagnostic);
		expect(Object.isFrozen(result.index)).toBe(true);
		expect(Object.isFrozen(result.index.skills)).toBe(true);
		expect(Object.isFrozen(result.index.byName)).toBe(true);
		expect(Object.isFrozen(result.index.diagnostics)).toBe(true);
		expect("set" in result.index.byName).toBe(false);
		expect(Object.isFrozen(result.index.byName.get("review"))).toBe(true);
		expect(Object.isFrozen(result.index.byName.get("review")?.metadata.keywords)).toBe(true);
	});

	it("orders winners by source rank, normalized name, and canonical path", () => {
		const result = resolveSkillConflicts([
			descriptor("zeta", "user", "conventional", "/z/SKILL.md"),
			descriptor("beta", "project", "conventional", "/b/SKILL.md"),
			descriptor("alpha", "project", "conventional", "/a/SKILL.md"),
			descriptor("middle", "project", "manifest", "/m/SKILL.md"),
		]);

		expect(result.index.skills.map((skill) => skill.metadata.name)).toEqual(["middle", "alpha", "beta", "zeta"]);
	});
});
