import type { InteractiveCommand } from "./interactive-commands.ts";
import { INTERACTIVE_COMMANDS } from "./interactive-commands.ts";
import { parseModelCommand } from "./model-settings.ts";

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

const BUILTIN_ALIASES = new Set(["/help", "/quit", "/resume"]);

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
	const builtins = new Set(commands.map((command) => command.name));

	if (builtins.has(token) || BUILTIN_ALIASES.has(token)) {
		const error = validateBuiltin(token, args);
		return error ? { kind: "error", message: error } : { kind: "builtin", name: token, args };
	}

	const skillName = token.slice(1);
	const normalizedSkillName = skillName.normalize("NFKC").toLowerCase();
	const skill = index.byName.get(normalizedSkillName);
	if (skill && skill.metadata.name.normalize("NFKC").toLowerCase() === normalizedSkillName) {
		return { kind: "skill", name: skill.metadata.name, args, explicit: true };
	}

	return { kind: "text", text: line };
}

function validateBuiltin(name: string, args: string): string | undefined {
	if (name === "/skill" && args.length === 0) {
		return "Usage: /skill <name> [args], /skill -<name>, or /skill all";
	}
	if (name === "/skill" && args === "-") {
		return "Usage: /skill -<name>";
	}
	if (name === "/skills" && (args === "mode" || args.startsWith("mode "))) {
		const parts = args.split(/\s+/u);
		if (parts.length !== 2 || !isSkillMode(parts[1])) {
			return "Usage: /skills mode progressive|full|index";
		}
	}
	if (name === "/model") {
		const parsed = parseModelCommand(args);
		return parsed.kind === "error" ? parsed.message : undefined;
	}
	return undefined;
}

function isSkillMode(value: string | undefined): boolean {
	return value === "progressive" || value === "full" || value === "index";
}
