import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatSkillsPrompt, loadSkills } from "../src/skills.ts";

describe("skills", () => {
	it("loads SKILL.md from cwd .pillow/skills", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "z-skills-"));
		const dir = join(cwd, ".pillow", "skills", "demo");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "SKILL.md"), "# Demo skill\nAlways say banana.\n", "utf-8");
		const skills = await loadSkills(cwd);
		expect(skills.some((skill) => skill.body.includes("banana"))).toBe(true);
		expect(formatSkillsPrompt(skills)).toContain("Demo skill");
	});
});
