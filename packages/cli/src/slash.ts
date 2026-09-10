import { findCommand } from "./command-registry.ts";
import type { InteractiveCommand } from "./command-types.ts";
import { INTERACTIVE_COMMANDS } from "./interactive-commands.ts";

export interface SlashSkillDescriptor {
	metadata: { name: string };
}

export interface SlashSkillIndex {
	byName: ReadonlyMap<string, SlashSkillDescriptor>;
}

export type ParsedInput =
	| { kind: "builtin"; name: string; args: string }
	| { kind: "skill"; name: string; args: string; explicit: true }
	| { kind: "text"; text: string }
	| { kind: "error"; message: string };

/** Parse a submitted line without performing commands, activation, or I/O. */
export function parseSlashInput(
	line: string,
	index: SlashSkillIndex,
	commands: readonly InteractiveCommand[] = INTERACTIVE_COMMANDS,
): ParsedInput {
	const trimmed = line.trim();
	if (!trimmed.startsWith("/")) {
		return { kind: "text", text: line };
	}

	const separator = trimmed.search(/\s/u);
	const token = separator < 0 ? trimmed : trimmed.slice(0, separator);
	const args = separator < 0 ? "" : trimmed.slice(separator).trimStart();
	const command = findCommand(commands, token);

	if (command) {
		const error = command.validate?.(args);
		return error ? { kind: "error", message: error } : { kind: "builtin", name: command.name, args };
	}

	const skillName = token.slice(1);
	const normalizedSkillName = skillName.normalize("NFKC").toLowerCase();
	const skill = index.byName.get(normalizedSkillName);
	if (skill && skill.metadata.name.normalize("NFKC").toLowerCase() === normalizedSkillName) {
		return { kind: "skill", name: skill.metadata.name, args, explicit: true };
	}

	return { kind: "text", text: line };
}
