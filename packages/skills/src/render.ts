import type {
	Budget,
	MatchResult,
	RenderResult,
	RenderSkillContextInput,
	SkillDescriptor,
	SkillDiagnostic,
	SkillIdentity,
	SkillIndex,
	SkillInvocation,
	SkillState,
	TokenEstimator,
} from "./types.ts";

type SectionName = "available" | "active" | "matched" | "explicit";

interface RenderCandidate {
	key: string;
	name: string;
	section: SectionName;
	priority: number;
	order: number;
	text: string;
}

interface RenderModel {
	candidates: RenderCandidate[];
	diagnostics: SkillDiagnostic[];
	omittedNames: string[];
}

interface ValidBudget {
	limit: number;
	estimator: TokenEstimator;
}

const SECTION_TAGS: Readonly<Record<Exclude<SectionName, "explicit">, string>> = {
	available: "available_skills",
	active: "active_skills",
	matched: "matched_skills",
};

function normalizeName(value: string): string {
	return value.normalize("NFKC").toLowerCase();
}

function escapeXml(value: string): string {
	const xmlSafe = Array.from(value, (character) => {
		const code = character.codePointAt(0) ?? 0;
		return (code >= 0 && code <= 8) ||
			code === 11 ||
			code === 12 ||
			(code >= 14 && code <= 31) ||
			code === 0xfffe ||
			code === 0xffff
			? "\uFFFD"
			: character;
	}).join("");
	return xmlSafe
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function usageHint(skill: SkillDescriptor): string {
	return `Use skill_read skill=&quot;${escapeXml(skill.metadata.name)}&quot; with an optional relative path.`;
}

function metadataEntry(
	skill: SkillDescriptor,
	extra: { body?: string; score?: number; reasons?: readonly string[] } = {},
): string {
	const lines = [
		"  <skill>",
		`    <name>${escapeXml(skill.metadata.name)}</name>`,
		`    <description>${escapeXml(skill.metadata.description)}</description>`,
		`    <location>${escapeXml(skill.source.displayPath)}</location>`,
		`    <source>${skill.source.scope}/${skill.source.kind}</source>`,
		`    <usage>${usageHint(skill)}</usage>`,
	];
	if (extra.score !== undefined) {
		lines.push(`    <score>${extra.score}</score>`);
	}
	if (extra.reasons && extra.reasons.length > 0) {
		lines.push(`    <reasons>${escapeXml(extra.reasons.join("; "))}</reasons>`);
	}
	if (extra.body !== undefined) {
		lines.push(`    <instructions>${escapeXml(extra.body)}</instructions>`);
	}
	lines.push("  </skill>");
	return lines.join("\n");
}

function invocationBlock(invocation: SkillInvocation): string {
	const args = invocation.args ?? "";
	return [
		`<skill name="${escapeXml(invocation.skill.metadata.name)}" location="${escapeXml(invocation.skill.source.displayPath)}">`,
		"References are relative to the skill directory.",
		"",
		escapeXml(invocation.body),
		"",
		`<user_instructions>${escapeXml(args)}</user_instructions>`,
		"</skill>",
	].join("\n");
}

function descriptorForIdentity(index: SkillIndex, identity: SkillIdentity): SkillDescriptor | undefined {
	const normalized = normalizeName(identity.name);
	const descriptor =
		index.byName.get(normalized) ??
		index.skills.find((candidate) => normalizeName(candidate.metadata.name) === normalized);
	if (!descriptor || descriptor.source.canonicalPath !== identity.canonicalPath) {
		return undefined;
	}
	if (!descriptor.contentHash || descriptor.contentHash !== identity.contentHash) {
		return undefined;
	}
	return descriptor;
}

function bodyFor(skill: SkillDescriptor, input: RenderSkillContextInput): string | undefined {
	return input.bodies?.get(normalizeName(skill.metadata.name)) ?? skill.body;
}

function staleNames(state: SkillState): Set<string> {
	return new Set(state.stale.map((identity) => normalizeName(identity.name)));
}

function addBodyMissing(diagnostics: SkillDiagnostic[], skill: SkillDescriptor, registryVersion: number): void {
	diagnostics.push({
		code: "body_missing",
		severity: "warning",
		message: "Full context mode could not load the complete skill body",
		skillName: skill.metadata.name,
		registryVersion,
	});
}

function buildModel(input: RenderSkillContextInput): RenderModel {
	const candidates: RenderCandidate[] = [];
	const diagnostics: SkillDiagnostic[] = [];
	const omittedNames: string[] = [];
	let order = 0;
	const stale = staleNames(input.state);
	const manualOff = new Set(input.state.manualOffNames.map(normalizeName));
	const explicitName = input.explicitInvocation
		? normalizeName(input.explicitInvocation.skill.metadata.name)
		: undefined;
	const acceptedMatches = (input.matches?.matches ?? []).filter(
		(match) =>
			match.accepted &&
			!match.exclusion &&
			!match.skill.metadata.disableModelInvocation &&
			!manualOff.has(normalizeName(match.skill.metadata.name)),
	);
	const matchedNames = new Set(acceptedMatches.map((match) => normalizeName(match.skill.metadata.name)));

	for (const skill of input.index.skills) {
		if (skill.metadata.disableModelInvocation || stale.has(normalizeName(skill.metadata.name))) {
			continue;
		}
		candidates.push({
			key: `available:${skill.source.canonicalPath}`,
			name: skill.metadata.name,
			section: "available",
			priority: 4,
			order: order++,
			text: metadataEntry(skill),
		});
	}

	for (const identity of input.state.active) {
		const normalized = normalizeName(identity.name);
		if (stale.has(normalized)) {
			continue;
		}
		const skill = descriptorForIdentity(input.index, identity);
		if (!skill) {
			omittedNames.push(identity.name);
			diagnostics.push({
				code: "body_changed",
				severity: "warning",
				message: "An active skill identity did not match the current registry and was omitted",
				skillName: identity.name,
				registryVersion: input.index.version,
			});
			continue;
		}
		let body: string | undefined;
		if (input.state.mode === "full" && !matchedNames.has(normalized) && normalized !== explicitName) {
			body = bodyFor(skill, input);
			if (body === undefined) {
				addBodyMissing(diagnostics, skill, input.index.version);
			}
		}
		candidates.push({
			key: `active:${skill.source.canonicalPath}`,
			name: skill.metadata.name,
			section: "active",
			priority: 3,
			order: order++,
			text: metadataEntry(skill, { body }),
		});
	}

	for (const match of acceptedMatches) {
		const skill = match.skill;
		if (stale.has(normalizeName(skill.metadata.name))) {
			continue;
		}
		let body: string | undefined;
		if (input.state.mode === "full" && normalizeName(skill.metadata.name) !== explicitName) {
			body = bodyFor(skill, input);
			if (body === undefined) {
				addBodyMissing(diagnostics, skill, input.index.version);
			}
		}
		candidates.push({
			key: `matched:${skill.source.canonicalPath}`,
			name: skill.metadata.name,
			section: "matched",
			priority: 2,
			order: order++,
			text: metadataEntry(skill, { score: match.score, reasons: match.reasons, body }),
		});
	}

	if (input.explicitInvocation) {
		candidates.push({
			key: `explicit:${input.explicitInvocation.skill.source.canonicalPath}`,
			name: input.explicitInvocation.skill.metadata.name,
			section: "explicit",
			priority: 1,
			order: order++,
			text: invocationBlock(input.explicitInvocation),
		});
	}

	return { candidates, diagnostics, omittedNames };
}

function serialize(candidates: readonly RenderCandidate[]): string {
	const selected = new Set(candidates.map((candidate) => candidate.key));
	const blocks: string[] = [];
	for (const section of ["available", "active", "matched"] as const) {
		const entries = candidates
			.filter((candidate) => selected.has(candidate.key) && candidate.section === section)
			.sort((left, right) => left.order - right.order);
		if (entries.length > 0) {
			const tag = SECTION_TAGS[section];
			blocks.push(`<${tag}>\n${entries.map((entry) => entry.text).join("\n")}\n</${tag}>`);
		}
	}
	blocks.push(
		...candidates
			.filter((candidate) => selected.has(candidate.key) && candidate.section === "explicit")
			.sort((left, right) => left.order - right.order)
			.map((candidate) => candidate.text),
	);
	return blocks.join("\n");
}

function defaultEstimator(text: string): number {
	return Math.ceil(text.length / 4);
}

function validateBudget(budget: Budget): { value?: ValidBudget; diagnostic?: SkillDiagnostic } {
	const window = budget.contextWindow;
	if (!Number.isFinite(window) || window <= 0) {
		return {
			diagnostic: {
				code: "budget_exceeded",
				severity: "error",
				message: "Skills context requires a finite, positive context window",
			},
		};
	}
	const base = budget.baseContextTokens ?? 0;
	const output = budget.outputReserve ?? Math.ceil(window * 0.1);
	const safety = budget.safetyReserve ?? Math.ceil(window * 0.05);
	if (![base, output, safety].every((value) => Number.isFinite(value) && value >= 0)) {
		return {
			diagnostic: {
				code: "budget_exceeded",
				severity: "error",
				message: "Skills context reserves must be finite, non-negative token counts",
			},
		};
	}
	const requestedEstimator = budget.estimator ?? defaultEstimator;
	const estimator: TokenEstimator = (text) => {
		try {
			const estimate = requestedEstimator(text);
			return Number.isFinite(estimate) && estimate >= 0 ? estimate : defaultEstimator(text);
		} catch {
			return defaultEstimator(text);
		}
	};
	const available = Math.max(0, window - base - output - safety);
	return { value: { limit: Math.floor(Math.min(available, window * 0.15)), estimator } };
}

function budgetDiagnostic(candidate: RenderCandidate, limit: number): SkillDiagnostic {
	return {
		code: "budget_exceeded",
		severity: "warning",
		message: `Omitted ${candidate.section} skill entry because it did not fit the ${limit}-token skills budget`,
		skillName: candidate.name,
	};
}

function allocate(model: RenderModel, budget: Budget): RenderResult {
	const checked = validateBudget(budget);
	if (!checked.value) {
		return {
			text: "",
			includedNames: [],
			omittedNames: unique([...model.omittedNames, ...model.candidates.map((candidate) => candidate.name)]),
			estimatedTokens: 0,
			diagnostics: [...model.diagnostics, checked.diagnostic!],
		};
	}

	const selected: RenderCandidate[] = [];
	const omitted = [...model.omittedNames];
	const diagnostics = [...model.diagnostics];
	const allocationOrder = [...model.candidates].sort(
		(left, right) => left.priority - right.priority || left.order - right.order,
	);
	for (const candidate of allocationOrder) {
		const tentative = [...selected, candidate];
		const text = serialize(tentative);
		let estimate: number;
		try {
			estimate = text.length === 0 ? 0 : checked.value.estimator(text);
		} catch {
			estimate = Number.POSITIVE_INFINITY;
		}
		if (Number.isFinite(estimate) && estimate >= 0 && estimate <= checked.value.limit) {
			selected.push(candidate);
		} else {
			omitted.push(candidate.name);
			diagnostics.push(budgetDiagnostic(candidate, checked.value.limit));
		}
	}

	const text = serialize(selected);
	let estimatedTokens = 0;
	try {
		estimatedTokens = text.length === 0 ? 0 : checked.value.estimator(text);
	} catch {
		estimatedTokens = 0;
	}
	return {
		text,
		includedNames: unique(
			selected.sort((left, right) => left.order - right.order).map((candidate) => candidate.name),
		),
		omittedNames: unique(omitted),
		estimatedTokens,
		diagnostics,
	};
}

function emptyState(): SkillState {
	return { active: [], manualOffNames: [], mode: "progressive", stale: [], diagnostics: [] };
}

function emptyIndex(skills: readonly SkillDescriptor[] = []): SkillIndex {
	return {
		version: 1,
		skills,
		byName: new Map(skills.map((skill) => [normalizeName(skill.metadata.name), skill])),
		diagnostics: [],
	};
}

export function renderSkillContext(input: RenderSkillContextInput, budget: Budget): RenderResult {
	return allocate(buildModel(input), budget);
}

export function formatAvailableSkills(index: SkillIndex, budget: Budget): RenderResult {
	return renderSkillContext({ index, state: emptyState() }, budget);
}

export function formatActiveSkills(state: SkillState, index: SkillIndex, budget: Budget): RenderResult {
	return renderSkillContext({ index: { ...index, skills: [] }, state }, budget);
}

export function formatSkillInvocation(
	skill: SkillDescriptor,
	body: string,
	args: string,
	budget: Budget,
): RenderResult {
	return renderSkillContext(
		{
			index: emptyIndex(),
			state: emptyState(),
			explicitInvocation: { skill, body, args },
		},
		budget,
	);
}

export function formatMatchedSkills(
	matches: MatchResult,
	index: SkillIndex,
	state: SkillState,
	budget: Budget,
): RenderResult {
	return renderSkillContext({ index: { ...index, skills: [] }, state: { ...state, active: [] }, matches }, budget);
}
