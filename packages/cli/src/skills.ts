/**
 * Discover SKILL.md files and fold them into the system prompt.
 */

import type { Stats } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { pillowProjectDir, pillowUserDir } from "./pillow-home.ts";

export interface Skill {
	name: string;
	body: string;
	path: string;
}

async function readSkillFile(path: string): Promise<Skill | undefined> {
	try {
		const body = await readFile(path, "utf-8");
		const name = body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? path;
		return { name, body, path };
	} catch {
		return undefined;
	}
}

async function skillsFromDir(dir: string): Promise<Skill[]> {
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const skills: Skill[] = [];
	for (const name of names) {
		const full = join(dir, name);
		let info: Stats | undefined;
		try {
			info = await stat(full);
		} catch {
			continue;
		}
		if (info.isFile() && name.toLowerCase() === "skill.md") {
			const skill = await readSkillFile(full);
			if (skill) {
				skills.push(skill);
			}
		} else if (info.isDirectory()) {
			const nested = await readSkillFile(join(full, "SKILL.md"));
			if (nested) {
				skills.push(nested);
			}
		}
	}
	return skills;
}

export function skillSearchDirs(cwd: string): string[] {
	return [join(pillowUserDir(), "skills"), join(pillowProjectDir(cwd), "skills")];
}

export async function loadSkills(cwd: string): Promise<Skill[]> {
	const found: Skill[] = [];
	const seen = new Set<string>();
	for (const dir of skillSearchDirs(cwd)) {
		for (const skill of await skillsFromDir(dir)) {
			if (seen.has(skill.name)) {
				continue;
			}
			seen.add(skill.name);
			found.push(skill);
		}
	}
	return found;
}

export function formatSkillsPrompt(skills: Skill[]): string {
	if (skills.length === 0) {
		return "";
	}
	const blocks = skills.map((skill) => `### ${skill.name}\n${skill.body}`);
	return `\n\n# Skills\n${blocks.join("\n\n")}`;
}
