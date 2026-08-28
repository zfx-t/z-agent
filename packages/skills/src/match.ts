import picomatch from "picomatch";
import type {
	MatchOptions,
	MatchRequest,
	MatchResult,
	SkillDescriptor,
	SkillDiagnostic,
	SkillIndex,
	SkillMatch,
	SkillMatchExclusion,
} from "./types.ts";

const DEFAULT_THRESHOLD = 35;
const DEFAULT_MAX_NEW = 2;
const DEFAULT_MAX_ACTIVE = 8;

function normalizeName(value: string): string {
	return value.normalize("NFKC").toLowerCase();
}

function tokens(value: string): string[] {
	return normalizeName(value).match(/[\p{L}\p{N}]+/gu) ?? [];
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function hasSequence(haystack: readonly string[], needle: readonly string[]): boolean {
	if (needle.length === 0 || needle.length > haystack.length) {
		return false;
	}
	for (let start = 0; start <= haystack.length - needle.length; start += 1) {
		if (needle.every((token, offset) => haystack[start + offset] === token)) {
			return true;
		}
	}
	return false;
}

function overlap(left: readonly string[], right: ReadonlySet<string>): string[] {
	return unique(left).filter((token) => right.has(token));
}

function normalizePathHint(value: string): string {
	const normalized = value.normalize("NFKC").replaceAll("\\", "/");
	return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

function matchingGlobs(skill: SkillDescriptor, pathHints: readonly string[]): string[] {
	const normalizedHints = pathHints.map(normalizePathHint);
	const matches: string[] = [];
	for (const glob of unique(skill.metadata.fileGlobs)) {
		try {
			const matcher = picomatch(glob, { dot: true });
			if (normalizedHints.some((hint) => matcher(hint))) {
				matches.push(glob);
			}
		} catch {
			// Invalid patterns are parser diagnostics and never make matching fail.
		}
	}
	return matches;
}

function scoreSkill(
	skill: SkillDescriptor,
	requestTokens: readonly string[],
	pathHints: readonly string[],
): {
	score: number;
	reasons: string[];
} {
	const requestSet = new Set(requestTokens);
	const reasons: string[] = [];
	let score = 0;

	const nameTokens = unique(tokens(skill.metadata.name));
	if (hasSequence(requestTokens, nameTokens)) {
		score += 100;
		reasons.push("exact_name_phrase:100");
	} else {
		const sharedName = overlap(nameTokens, requestSet);
		const nameScore = Math.min(80, sharedName.length * 40);
		if (nameScore > 0) {
			score += nameScore;
			reasons.push(`name_overlap:${nameScore} (${sharedName.join(",")})`);
		}
	}

	const keywordTokens = unique(skill.metadata.keywords.flatMap(tokens));
	const sharedKeywords = overlap(keywordTokens, requestSet);
	const keywordScore = Math.min(60, sharedKeywords.length * 30);
	if (keywordScore > 0) {
		score += keywordScore;
		reasons.push(`keyword_overlap:${keywordScore} (${sharedKeywords.join(",")})`);
	}

	const descriptionTokens = unique(tokens(skill.metadata.description));
	const sharedDescription = overlap(descriptionTokens, requestSet);
	const descriptionScore = Math.min(30, sharedDescription.length * 6);
	if (descriptionScore > 0) {
		score += descriptionScore;
		reasons.push(`description_overlap:${descriptionScore} (${sharedDescription.join(",")})`);
	}

	const globs = matchingGlobs(skill, pathHints);
	const globScore = Math.min(70, globs.length * 35);
	if (globScore > 0) {
		score += globScore;
		reasons.push(`file_glob:${globScore} (${globs.join(",")})`);
	}

	return { score: Math.min(100, score), reasons };
}

function sourceRank(skill: SkillDescriptor): number {
	if (skill.source.scope === "project") {
		return skill.source.kind === "manifest" ? 4 : 3;
	}
	return skill.source.kind === "manifest" ? 2 : 1;
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function compareMatches(left: SkillMatch, right: SkillMatch): number {
	if (left.score !== right.score) {
		return right.score - left.score;
	}
	const rankDifference = sourceRank(right.skill) - sourceRank(left.skill);
	if (rankDifference !== 0) {
		return rankDifference;
	}
	const nameDifference = compareStrings(
		normalizeName(left.skill.metadata.name),
		normalizeName(right.skill.metadata.name),
	);
	if (nameDifference !== 0) {
		return nameDifference;
	}
	return compareStrings(left.skill.source.canonicalPath, right.skill.source.canonicalPath);
}

function finiteOption(value: number | undefined, fallback: number, minimum: number, maximum?: number): number {
	if (value === undefined || !Number.isFinite(value)) {
		return fallback;
	}
	const integer = Math.floor(value);
	const bounded = Math.max(minimum, integer);
	return maximum === undefined ? bounded : Math.min(maximum, bounded);
}

function exclusionBeforeCaps(
	skill: SkillDescriptor,
	score: number,
	threshold: number,
	manualOff: ReadonlySet<string>,
	stale: ReadonlySet<string>,
): SkillMatchExclusion | undefined {
	const name = normalizeName(skill.metadata.name);
	if (skill.metadata.disableModelInvocation) {
		return "hidden";
	}
	if (stale.has(name)) {
		return "stale";
	}
	if (manualOff.has(name)) {
		return "manual_off";
	}
	if (score < threshold) {
		return "threshold";
	}
	return undefined;
}

function capDiagnostic(
	skill: SkillDescriptor,
	exclusion: "turn_limit" | "session_limit",
	limit: number,
): SkillDiagnostic {
	const label = exclusion === "turn_limit" ? "turn" : "session";
	return {
		code: "activation_limit",
		severity: "info",
		message: `Automatic activation skipped because the ${label} limit (${limit}) was reached`,
		skillName: skill.metadata.name,
	};
}

export function matchSkills(request: MatchRequest, index: SkillIndex, options: MatchOptions = {}): MatchResult {
	const threshold = finiteOption(options.threshold, DEFAULT_THRESHOLD, 0, 100);
	const maxNew = finiteOption(options.maxNew, DEFAULT_MAX_NEW, 0);
	const maxActive = finiteOption(options.maxActive, DEFAULT_MAX_ACTIVE, 0);
	const requestTokens = tokens(request.text);
	const active = new Set((request.activeNames ?? []).map(normalizeName));
	const manualOff = new Set((request.manualOffNames ?? []).map(normalizeName));
	const stale = new Set((request.staleNames ?? []).map(normalizeName));

	const matches = index.skills
		.map((skill): SkillMatch => {
			const scored = scoreSkill(skill, requestTokens, request.pathHints ?? []);
			const exclusion = exclusionBeforeCaps(skill, scored.score, threshold, manualOff, stale);
			return {
				skill,
				score: scored.score,
				reasons: scored.reasons,
				accepted: exclusion === undefined && active.has(normalizeName(skill.metadata.name)),
				...(exclusion ? { exclusion } : {}),
			};
		})
		.sort(compareMatches);

	const activations: SkillDescriptor[] = [];
	const diagnostics: SkillDiagnostic[] = [];
	for (const match of matches) {
		if (match.exclusion) {
			continue;
		}
		const name = normalizeName(match.skill.metadata.name);
		if (active.has(name)) {
			match.accepted = true;
			continue;
		}
		if (active.size + activations.length >= maxActive) {
			match.accepted = false;
			match.exclusion = "session_limit";
			diagnostics.push(capDiagnostic(match.skill, "session_limit", maxActive));
			continue;
		}
		if (activations.length >= maxNew) {
			match.accepted = false;
			match.exclusion = "turn_limit";
			diagnostics.push(capDiagnostic(match.skill, "turn_limit", maxNew));
			continue;
		}
		match.accepted = true;
		activations.push(match.skill);
	}

	return { matches, activations, diagnostics };
}
