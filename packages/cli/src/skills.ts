/**
 * Compatibility entry point for callers that only need a discovery snapshot.
 * Runtime activation and provider rendering live in `skill-manager.ts`.
 */

import { join } from "node:path";
import { discoverSkills, resolveSkillConflicts, type SkillDescriptor, type SkillIndex } from "@z-agent/skills";
import { pillowProjectDir, pillowUserDir } from "./pillow-home.ts";

export function skillSearchDirs(cwd: string): string[] {
	return [join(pillowUserDir(), "skills"), join(pillowProjectDir(cwd), "skills")];
}

export async function loadSkillIndex(cwd: string): Promise<SkillIndex> {
	const userPillow = pillowUserDir();
	const projectPillow = pillowProjectDir(cwd);
	const discovered = await discoverSkills({
		cwd,
		userSkillsDir: join(userPillow, "skills"),
		projectSkillsDir: join(projectPillow, "skills"),
		userManifest: join(userPillow, "skills.json"),
		projectManifest: join(projectPillow, "skills.json"),
	});
	return resolveSkillConflicts(discovered.skills).index;
}

/** @deprecated Use `loadSkillIndex` and the runtime manager. */
export async function loadSkills(cwd: string): Promise<SkillDescriptor[]> {
	return [...(await loadSkillIndex(cwd)).skills];
}
