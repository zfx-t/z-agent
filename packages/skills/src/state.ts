import type {
	SkillActivationNode,
	SkillDeactivationNode,
	SkillDiagnostic,
	SkillIdentity,
	SkillIndex,
	SkillModeNode,
	SkillState,
	SkillStateNode,
} from "./types.ts";

function normalizeName(value: string): string {
	return value.normalize("NFKC").toLowerCase();
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function hasValidBase(node: SkillStateNode): boolean {
	return (
		node.schemaVersion === 1 &&
		isNonEmptyString(node.id) &&
		(node.parentId === null || typeof node.parentId === "string") &&
		Number.isFinite(node.createdAt)
	);
}

function validActivation(node: SkillActivationNode): boolean {
	return (
		hasValidBase(node) &&
		isNonEmptyString(node.skillName) &&
		isNonEmptyString(node.canonicalPath) &&
		isNonEmptyString(node.contentHash) &&
		(node.sourceScope === "user" || node.sourceScope === "project") &&
		(node.sourceKind === "manifest" || node.sourceKind === "conventional") &&
		(node.origin === "explicit" || node.origin === "automatic" || node.origin === "all" || node.origin === "command")
	);
}

function validDeactivation(node: SkillDeactivationNode): boolean {
	return (
		hasValidBase(node) &&
		isNonEmptyString(node.skillName) &&
		(node.canonicalPath === undefined || isNonEmptyString(node.canonicalPath)) &&
		(node.origin === "explicit" ||
			node.origin === "command" ||
			node.origin === "reload" ||
			node.origin === "reset") &&
		(node.origin !== "reset" || (node.skillName === "*" && node.canonicalPath === undefined))
	);
}

function validMode(node: SkillModeNode): boolean {
	return hasValidBase(node) && (node.mode === "progressive" || node.mode === "full" || node.mode === "index");
}

function invalidNodeDiagnostic(node: SkillStateNode): SkillDiagnostic {
	const skillName = "skillName" in node && typeof node.skillName === "string" ? node.skillName : undefined;
	return {
		code: "invalid_metadata",
		severity: "warning",
		message: `Ignored malformed ${String(node.type)} control node`,
		...(skillName ? { skillName } : {}),
	};
}

function identityFrom(node: SkillActivationNode): SkillIdentity {
	return {
		name: node.skillName,
		canonicalPath: node.canonicalPath,
		contentHash: node.contentHash,
		sourceScope: node.sourceScope,
		sourceKind: node.sourceKind,
	};
}

function matchingIdentity(identity: SkillIdentity | undefined, node: SkillDeactivationNode): identity is SkillIdentity {
	return Boolean(identity && (node.canonicalPath === undefined || identity.canonicalPath === node.canonicalPath));
}

export function reduceSkillState(nodes: readonly SkillStateNode[]): SkillState {
	const active = new Map<string, SkillIdentity>();
	const stale = new Map<string, SkillIdentity>();
	const manualOff = new Map<string, string>();
	const diagnostics: SkillDiagnostic[] = [];
	let mode: SkillState["mode"] = "progressive";

	for (const node of nodes) {
		if (node.type === "skill_activation") {
			if (!validActivation(node)) {
				diagnostics.push(invalidNodeDiagnostic(node));
				continue;
			}
			const name = normalizeName(node.skillName);
			if (manualOff.has(name) && node.origin !== "explicit") {
				continue;
			}
			if (stale.has(name) && node.origin !== "explicit") {
				diagnostics.push({
					code: "body_changed",
					severity: "warning",
					message: "A stale skill identity requires explicit activation before it can become active again",
					skillName: node.skillName,
				});
				continue;
			}
			if (node.origin === "explicit") {
				manualOff.delete(name);
				stale.delete(name);
			}
			active.delete(name);
			active.set(name, identityFrom(node));
			continue;
		}

		if (node.type === "skill_deactivation") {
			if (!validDeactivation(node)) {
				diagnostics.push(invalidNodeDiagnostic(node));
				continue;
			}
			if (node.origin === "reset") {
				active.clear();
				stale.clear();
				manualOff.clear();
				mode = "progressive";
				continue;
			}

			const name = normalizeName(node.skillName);
			const current = active.get(name);
			const staleCurrent = stale.get(name);
			if (matchingIdentity(current, node)) {
				active.delete(name);
				if (node.origin === "reload") {
					stale.set(name, current);
				}
			}
			if (node.origin === "explicit" || node.origin === "command") {
				if (
					node.canonicalPath === undefined ||
					current?.canonicalPath === node.canonicalPath ||
					staleCurrent?.canonicalPath === node.canonicalPath
				) {
					stale.delete(name);
					manualOff.set(name, node.skillName);
				}
			}
			continue;
		}

		if (!validMode(node)) {
			diagnostics.push(invalidNodeDiagnostic(node));
			continue;
		}
		mode = node.mode;
	}

	return {
		active: [...active.values()],
		manualOffNames: [...manualOff.values()],
		mode,
		stale: [...stale.values()],
		diagnostics,
	};
}

function findDescriptor(index: SkillIndex, name: string) {
	const normalized = normalizeName(name);
	return (
		index.byName.get(normalized) ?? index.skills.find((skill) => normalizeName(skill.metadata.name) === normalized)
	);
}

function diagnosticKey(diagnostic: SkillDiagnostic): string {
	return [
		diagnostic.code,
		diagnostic.severity,
		diagnostic.skillName ?? "",
		diagnostic.registryVersion ?? "",
		diagnostic.message,
	].join("\0");
}

function addDiagnostic(target: SkillDiagnostic[], seen: Set<string>, diagnostic: SkillDiagnostic): void {
	const key = diagnosticKey(diagnostic);
	if (!seen.has(key)) {
		seen.add(key);
		target.push(diagnostic);
	}
}

export function reconcileSkillState(state: SkillState, index: SkillIndex): SkillState {
	const active: SkillIdentity[] = [];
	const stale = new Map(state.stale.map((identity) => [normalizeName(identity.name), identity]));
	const diagnostics = [...state.diagnostics];
	const seenDiagnostics = new Set(diagnostics.map(diagnosticKey));

	for (const identity of state.active) {
		const name = normalizeName(identity.name);
		const descriptor = findDescriptor(index, identity.name);
		if (!descriptor) {
			stale.set(name, identity);
			addDiagnostic(diagnostics, seenDiagnostics, {
				code: "body_missing",
				severity: "warning",
				message: "The active skill is no longer present in the registry",
				skillName: identity.name,
				registryVersion: index.version,
			});
			continue;
		}
		if (descriptor.source.canonicalPath !== identity.canonicalPath) {
			stale.set(name, identity);
			addDiagnostic(diagnostics, seenDiagnostics, {
				code: "body_changed",
				severity: "warning",
				message: "The indexed skill name now resolves to a different canonical path",
				skillName: identity.name,
				registryVersion: index.version,
			});
			continue;
		}
		if (!descriptor.contentHash) {
			stale.set(name, identity);
			addDiagnostic(diagnostics, seenDiagnostics, {
				code: "body_missing",
				severity: "warning",
				message: "The indexed skill has no verified content hash",
				skillName: identity.name,
				registryVersion: index.version,
			});
			continue;
		}
		if (descriptor.contentHash !== identity.contentHash) {
			stale.set(name, identity);
			addDiagnostic(diagnostics, seenDiagnostics, {
				code: "body_changed",
				severity: "warning",
				message: "The indexed skill body changed since activation",
				skillName: identity.name,
				registryVersion: index.version,
			});
			continue;
		}
		active.push(identity);
	}

	return {
		active,
		manualOffNames: [...state.manualOffNames],
		mode: state.mode,
		stale: [...stale.values()],
		diagnostics,
	};
}
