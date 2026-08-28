import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSkillBody, readSkillResource } from "../src/index.ts";
import type { SkillDescriptor, SkillIndex } from "../src/types.ts";

function descriptor(baseDir: string, name = "review"): SkillDescriptor {
	const skillPath = join(baseDir, "SKILL.md");
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
			rootDir: baseDir,
			displayPath: `~/.pillow/skills/${name}/SKILL.md`,
			canonicalPath: skillPath,
		},
		baseDir,
		skillPath,
		canonicalBaseDir: baseDir,
		canonicalSkillPath: skillPath,
		diagnostics: [],
	};
}

function index(baseDir: string): SkillIndex {
	const entry = descriptor(baseDir);
	return { version: 1, skills: [entry], byName: new Map([["review", entry]]), diagnostics: [] };
}

async function fixture(): Promise<{ root: string; baseDir: string; skillIndex: SkillIndex }> {
	const root = await mkdtemp(join(tmpdir(), "z-skill-resource-"));
	const baseDir = join(root, "review");
	await mkdir(join(baseDir, "references"), { recursive: true });
	await writeFile(join(baseDir, "SKILL.md"), "---\nname: review\ndescription: Review\n---\n\nBody\n", "utf8");
	await writeFile(join(baseDir, "references", "guide.txt"), "read me", "utf8");
	return { root, baseDir, skillIndex: index(baseDir) };
}

describe("readSkillResource", () => {
	it("reads the default SKILL.md and nested UTF-8 text", async () => {
		const { skillIndex } = await fixture();
		const primary = await readSkillResource(skillIndex, "ＲＥＶＩＥＷ");
		expect(primary).toMatchObject({ skillName: "review", relativePath: "SKILL.md", mimeType: "text/markdown" });
		expect(primary.content).toContain("Body");

		const guide = await readSkillResource(skillIndex, "review", "./references/guide.txt");
		expect(guide).toEqual({
			skillName: "review",
			relativePath: "references/guide.txt",
			mimeType: "text/plain",
			content: "read me",
		});
	});

	it("loads the parsed body and stable SHA-256 content hash for activation", async () => {
		const { skillIndex } = await fixture();
		const raw = "---\nname: review\ndescription: Review\n---\n\nBody\n";
		await expect(readSkillBody(skillIndex, "review")).resolves.toEqual({
			skillName: "review",
			body: "\nBody\n",
			contentHash: createHash("sha256").update(raw, "utf8").digest("hex"),
		});
	});

	it("returns validated supported image bytes", async () => {
		const { baseDir, skillIndex } = await fixture();
		const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
		await writeFile(join(baseDir, "image.png"), png);
		const result = await readSkillResource(skillIndex, "review", "image.png");
		expect(result.mimeType).toBe("image/png");
		expect(result.content).toEqual(png);
	});

	it("rejects absolute paths, every parent traversal, directories, and unindexed names", async () => {
		const { baseDir, skillIndex } = await fixture();
		await expect(readSkillResource(skillIndex, "unknown")).rejects.toThrow("not indexed");
		await expect(readSkillResource(skillIndex, "review", "/etc/passwd")).rejects.toThrow("relative");
		await expect(readSkillResource(skillIndex, "review", "references/../SKILL.md")).rejects.toThrow(
			"parent traversal",
		);
		await expect(readSkillResource(skillIndex, "review", "..\\outside.txt")).rejects.toThrow("parent traversal");
		await expect(readSkillResource(skillIndex, "review", "references")).rejects.toThrow("regular file");
		await expect(readSkillResource(index(baseDir), "review", "C:\\Windows\\win.ini")).rejects.toThrow("relative");
	});

	it("rejects symlinks that canonically escape the indexed skill root", async () => {
		const { root, baseDir, skillIndex } = await fixture();
		const outside = join(root, "outside.txt");
		await writeFile(outside, "secret", "utf8");
		await symlink(outside, join(baseDir, "references", "outside.txt"));
		await expect(readSkillResource(skillIndex, "review", "references/outside.txt")).rejects.toThrow(
			"escapes skill root",
		);
	});

	it("allows an in-root symlink to a regular file but rejects invalid image content", async () => {
		const { baseDir, skillIndex } = await fixture();
		await symlink(join(baseDir, "references", "guide.txt"), join(baseDir, "guide-link.txt"));
		await expect(readSkillResource(skillIndex, "review", "guide-link.txt")).resolves.toMatchObject({
			content: "read me",
		});

		await writeFile(join(baseDir, "bad.png"), "not a png", "utf8");
		await expect(readSkillResource(skillIndex, "review", "bad.png")).rejects.toThrow("valid PNG");
	});

	it("rejects a skill root that was rebound after discovery", async () => {
		const { root, baseDir, skillIndex } = await fixture();
		const original = join(root, "review-original");
		const outside = join(root, "outside");
		await mkdir(outside);
		await writeFile(join(outside, "secret.txt"), "secret", "utf8");
		await rename(baseDir, original);
		await symlink(outside, baseDir, "dir");

		await expect(readSkillResource(skillIndex, "review", "secret.txt")).rejects.toThrow("Indexed skill paths");
	});

	it("rejects aliases into a nested indexed skill while preserving the nested skill's own reads", async () => {
		const root = await mkdtemp(join(tmpdir(), "z-skill-resource-alias-"));
		const parentDir = join(root, "parent");
		const childDir = join(parentDir, "child");
		await mkdir(childDir, { recursive: true });
		await writeFile(join(parentDir, "SKILL.md"), "---\nname: parent\ndescription: Parent\n---\nParent\n", "utf8");
		await writeFile(join(childDir, "SKILL.md"), "---\nname: child\ndescription: Child\n---\nChild\n", "utf8");
		await writeFile(join(childDir, "guide.txt"), "child resource", "utf8");
		const parent = descriptor(parentDir, "parent");
		const child = descriptor(childDir, "child");
		const skillIndex: SkillIndex = {
			version: 1,
			skills: [parent, child],
			byName: new Map([
				["parent", parent],
				["child", child],
			]),
			diagnostics: [],
		};

		await expect(readSkillResource(skillIndex, "parent", "child/SKILL.md")).rejects.toThrow(
			"aliases another indexed skill",
		);
		await expect(readSkillResource(skillIndex, "parent", "child/guide.txt")).rejects.toThrow(
			"aliases another indexed skill",
		);
		await expect(readSkillResource(skillIndex, "child", "guide.txt")).resolves.toMatchObject({
			content: "child resource",
		});
	});
});
