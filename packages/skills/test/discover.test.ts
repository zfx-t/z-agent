import type { Dirent, Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverSkills } from "../src/index.ts";
import type { SkillFs } from "../src/types.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function temporaryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "z-agent-skills-"));
	temporaryRoots.push(root);
	return root;
}

async function writeSkill(directory: string, name: string, description = `${name} description`): Promise<string> {
	await mkdir(directory, { recursive: true });
	const path = join(directory, "SKILL.md");
	await writeFile(
		path,
		`---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n${"body ".repeat(2_000)}`,
		"utf8",
	);
	return path;
}

function nativeFs(overrides: Partial<SkillFs> = {}): SkillFs {
	return {
		readFile: async (path, encoding) => await readFile(path, encoding),
		readFilePrefix: async (path, maxBytes) => {
			const content = await readFile(path);
			return content.subarray(0, maxBytes).toString("utf8");
		},
		readdir: async (path) => (await readdir(path, { withFileTypes: true })) as Dirent[],
		lstat: async (path) => (await lstat(path)) as Stats,
		stat: async (path) => (await stat(path)) as Stats,
		realpath,
		...overrides,
	};
}

describe("discoverSkills", () => {
	it("recurses deterministically, stops at skill roots, and honors ignore files", async () => {
		const root = await temporaryRoot();
		const cwd = join(root, "project");
		const userHome = join(root, "user-pillow");
		const userSkills = join(userHome, "skills");
		const projectSkills = join(cwd, ".pillow", "skills");

		await writeSkill(join(userSkills, "alpha"), "alpha");
		await writeSkill(join(userSkills, "alpha", "child"), "alpha-child");
		await writeSkill(join(userSkills, "group", "beta"), "beta");
		await writeSkill(join(userSkills, ".hidden", "secret"), "secret");
		await writeSkill(join(userSkills, "node_modules", "dependency"), "dependency");
		await writeSkill(join(userSkills, "ignored"), "ignored");
		await writeSkill(join(userSkills, "fd-ignored"), "fd-ignored");
		await writeFile(join(userSkills, ".gitignore"), "ignored/\n", "utf8");
		await writeFile(join(userSkills, ".fdignore"), "fd-ignored/\n", "utf8");
		await writeSkill(projectSkills, "project-root");
		await writeSkill(join(projectSkills, "not-reached"), "not-reached");

		const result = await discoverSkills({ cwd, userHome });

		expect(result.skills.map((skill) => skill.metadata.name)).toEqual(["alpha", "beta", "project-root"]);
		expect(result.skills.every((skill) => skill.body === undefined)).toBe(true);
		expect(result.skills.every((skill) => skill.statFingerprint?.size)).toBe(true);
	});

	it("keeps scanning after an unreadable skill and reports the path", async () => {
		const root = await temporaryRoot();
		const cwd = join(root, "project");
		const skillsDir = join(cwd, ".pillow", "skills");
		await writeSkill(join(skillsDir, "blocked"), "blocked");
		await writeSkill(join(skillsDir, "healthy"), "healthy");

		const adapter = nativeFs({
			readFilePrefix: async (path, maxBytes) => {
				if (path.endsWith(join("blocked", "SKILL.md"))) {
					const error = new Error("permission denied");
					Object.assign(error, { code: "EACCES" });
					throw error;
				}
				const content = await readFile(path);
				return content.subarray(0, maxBytes).toString("utf8");
			},
		});
		const result = await discoverSkills({ cwd, userHome: join(root, "missing-user"), fs: adapter });

		expect(result.skills.map((skill) => skill.metadata.name)).toEqual(["healthy"]);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "path_unreadable",
				severity: "warning",
				path: expect.stringContaining(join("blocked", "SKILL.md")),
			}),
		);
	});

	it("never falls back to an unbounded full-file read when prefix reads are unavailable", async () => {
		const root = await temporaryRoot();
		const cwd = join(root, "project");
		const skillPath = await writeSkill(join(cwd, ".pillow", "skills", "bounded"), "bounded");
		const fullSkillReads: string[] = [];
		const adapter: SkillFs = {
			readFile: async (path, encoding) => {
				if (path === skillPath) {
					fullSkillReads.push(path);
				}
				return await readFile(path, encoding);
			},
			readdir: async (path) => (await readdir(path, { withFileTypes: true })) as Dirent[],
			lstat: async (path) => (await lstat(path)) as Stats,
			stat: async (path) => (await stat(path)) as Stats,
			realpath,
		};

		const result = await discoverSkills({ cwd, userHome: join(root, "missing-user"), fs: adapter });

		expect(result.skills).toEqual([]);
		expect(fullSkillReads).toEqual([]);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "path_unreadable",
				message: expect.stringContaining("bounded readFilePrefix"),
			}),
		);
	});

	it("rejects filesystem adapters that return more than the requested prefix", async () => {
		const root = await temporaryRoot();
		const cwd = join(root, "project");
		await writeSkill(join(cwd, ".pillow", "skills", "oversized"), "oversized");
		const adapter = nativeFs({
			readFilePrefix: async (_path, maxBytes) => "x".repeat(maxBytes + 1),
		});

		const result = await discoverSkills({ cwd, userHome: join(root, "missing-user"), fs: adapter });

		expect(result.skills).toEqual([]);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "path_unreadable",
				message: expect.stringContaining("exceeded"),
			}),
		);
	});

	it("expands additive manifest entries and ignores non-SKILL Markdown files visibly", async () => {
		const root = await temporaryRoot();
		const cwd = join(root, "project");
		const userHome = join(root, "user-pillow");
		await writeSkill(join(cwd, ".pillow", "skills", "local"), "local");
		await writeSkill(join(userHome, "external", "one"), "one");
		await writeSkill(join(userHome, "external", "two"), "two");
		await writeSkill(join(userHome, "collection", "nested", "three"), "three");
		await writeFile(join(userHome, "collection", "README.md"), "not a skill", "utf8");
		await writeFile(
			join(userHome, "skills.json"),
			JSON.stringify({
				skills: ["./external/one", "./external/two/SKILL.md", "./collection/**/*.md", "./missing/**/*.md"],
			}),
			"utf8",
		);

		const result = await discoverSkills({ cwd, userHome });

		expect(result.skills.map((skill) => skill.metadata.name)).toEqual(["local", "one", "two", "three"]);
		expect(
			result.skills
				.filter((skill) => skill.metadata.name !== "local")
				.every((skill) => skill.source.kind === "manifest"),
		).toBe(true);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({ code: "glob_no_match", path: join(userHome, "skills.json") }),
		);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({ code: "manifest_invalid", path: expect.stringContaining("README.md") }),
		);
	});

	it("rejects lexical and canonical manifest escapes while accepting an internal symlink once", async () => {
		const root = await temporaryRoot();
		const cwd = join(root, "project");
		const manifestDir = join(cwd, ".pillow");
		const outsideDir = join(root, "outside");
		const outsideSkill = await writeSkill(outsideDir, "outside");
		const insideSkill = await writeSkill(join(manifestDir, "shared", "inside"), "inside");
		await mkdir(manifestDir, { recursive: true });
		await symlink(dirname(outsideSkill), join(manifestDir, "escape"), "dir");
		await symlink(join(manifestDir, "shared", "inside"), join(manifestDir, "inside-link"), "dir");
		await symlink(join(manifestDir, "does-not-exist"), join(manifestDir, "broken"), "dir");
		await writeFile(
			join(manifestDir, "skills.json"),
			JSON.stringify({
				skills: [outsideSkill, "../outside", "./escape", "./broken", "./inside-link", "./shared/inside/SKILL.md"],
			}),
			"utf8",
		);

		const result = await discoverSkills({ cwd, userHome: join(root, "missing-user") });
		const canonicalInside = await realpath(insideSkill);

		expect(result.skills).toHaveLength(1);
		expect(result.skills[0]?.metadata.name).toBe("inside");
		expect(result.skills[0]?.source.canonicalPath).toBe(canonicalInside);
		expect(result.diagnostics.filter((item) => item.code === "manifest_escape").length).toBeGreaterThanOrEqual(3);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({ code: "path_unreadable", path: expect.stringContaining("broken") }),
		);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({ code: "duplicate_path", skillName: "inside" }),
		);
	});

	it("reports malformed and oversized manifest patterns without throwing", async () => {
		const root = await temporaryRoot();
		const cwd = join(root, "project");
		const manifestDir = join(cwd, ".pillow");
		await mkdir(manifestDir, { recursive: true });
		await writeFile(join(manifestDir, "skills.json"), JSON.stringify({ skills: ["(", "x".repeat(5_000)] }), "utf8");

		const result = await discoverSkills({ cwd, userHome: join(root, "missing-user") });

		expect(result.skills).toEqual([]);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({ code: "glob_no_match", message: expect.stringContaining("(") }),
		);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({ code: "manifest_invalid", message: expect.stringContaining("4096-byte limit") }),
		);
	});
});
