import { immutableMap } from "./immutable-map.ts";
import type { ResolveOptions, ResolveResult, SkillDescriptor, SkillDiagnostic, SkillIndex } from "./types.ts";

function normalizedName(name: string): string {
	return name.normalize("NFKC").toLowerCase();
}

function sourceRank(skill: SkillDescriptor): number {
	if (skill.source.scope === "project") {
		return skill.source.kind === "manifest" ? 0 : 1;
	}
	return skill.source.kind === "manifest" ? 2 : 3;
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function compareDescriptors(left: SkillDescriptor, right: SkillDescriptor): number {
	return (
		sourceRank(left) - sourceRank(right) ||
		compareStrings(normalizedName(left.metadata.name), normalizedName(right.metadata.name)) ||
		compareStrings(left.source.canonicalPath, right.source.canonicalPath)
	);
}

function registryVersion(options: ResolveOptions | undefined): number {
	const requested = options?.version;
	return typeof requested === "number" && Number.isSafeInteger(requested) && requested > 0 ? requested : 1;
}

function immutableUnknown(value: unknown): unknown {
	if (Array.isArray(value)) {
		return Object.freeze(value.map(immutableUnknown));
	}
	if (value && typeof value === "object") {
		const record = value as Readonly<Record<string, unknown>>;
		return Object.freeze(
			Object.fromEntries(Object.entries(record).map(([key, child]) => [key, immutableUnknown(child)])),
		);
	}
	return value;
}

function immutableDescriptor(skill: SkillDescriptor): SkillDescriptor {
	return Object.freeze({
		...skill,
		metadata: Object.freeze({
			...skill.metadata,
			keywords: Object.freeze([...skill.metadata.keywords]),
			fileGlobs: Object.freeze([...skill.metadata.fileGlobs]),
			allowedTools: Object.freeze([...skill.metadata.allowedTools]),
			extra: immutableUnknown(skill.metadata.extra) as Readonly<Record<string, unknown>>,
		}),
		source: Object.freeze({ ...skill.source }),
		...(skill.statFingerprint ? { statFingerprint: Object.freeze({ ...skill.statFingerprint }) } : {}),
		diagnostics: Object.freeze(skill.diagnostics.slice()),
	});
}

export function resolveSkillConflicts(skills: readonly SkillDescriptor[], options?: ResolveOptions): ResolveResult {
	const version = registryVersion(options);
	const ordered = skills.slice().sort(compareDescriptors);
	const diagnostics: SkillDiagnostic[] = [];
	for (const skill of ordered) {
		diagnostics.push(...skill.diagnostics);
	}

	const selected: SkillDescriptor[] = [];
	const byName = new Map<string, SkillDescriptor>();
	const byCanonicalPath = new Map<string, SkillDescriptor>();
	for (const skill of ordered) {
		const existingPath = byCanonicalPath.get(skill.source.canonicalPath);
		if (existingPath) {
			diagnostics.push({
				code: "duplicate_path",
				severity: "info",
				message: `Ignoring duplicate skill path already considered as ${existingPath.source.displayPath}`,
				path: skill.source.displayPath,
				skillName: skill.metadata.name,
				registryVersion: version,
			});
			continue;
		}

		const lookupName = normalizedName(skill.metadata.name);
		const existingName = byName.get(lookupName);
		if (existingName) {
			diagnostics.push({
				code: "name_collision",
				severity: "warning",
				message: `Ignoring colliding skill name; selected ${existingName.source.displayPath}`,
				path: skill.source.displayPath,
				skillName: skill.metadata.name,
				registryVersion: version,
			});
			byCanonicalPath.set(skill.source.canonicalPath, skill);
			continue;
		}

		const immutableSkill = immutableDescriptor(skill);
		byCanonicalPath.set(skill.source.canonicalPath, immutableSkill);
		byName.set(lookupName, immutableSkill);
		selected.push(immutableSkill);
	}

	const frozenDiagnostics = Object.freeze(diagnostics.slice());
	const frozenSkills = Object.freeze(selected.slice());
	const frozenByName = immutableMap(byName);
	const index: SkillIndex = Object.freeze({
		version,
		skills: frozenSkills,
		byName: frozenByName,
		diagnostics: frozenDiagnostics,
	});
	return { index, diagnostics: frozenDiagnostics };
}
