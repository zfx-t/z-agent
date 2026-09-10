import type { CommandContext, CommandRunResult, InteractiveCommand } from "./command-types.ts";

export type RegisterCommandResult =
	| { ok: true }
	| { ok: false; reason: "builtin_override" | "duplicate"; detail: string };

export class CommandRegistry {
	private readonly commands: InteractiveCommand[] = [];
	private readonly byToken = new Map<string, InteractiveCommand>();

	register(command: InteractiveCommand): RegisterCommandResult {
		const tokens = commandTokens(command);
		for (const token of tokens) {
			const existing = this.byToken.get(token);
			if (!existing) {
				continue;
			}
			if (existing.source === "builtin") {
				return { ok: false, reason: "builtin_override", detail: token };
			}
			return { ok: false, reason: "duplicate", detail: token };
		}
		this.commands.push(command);
		for (const token of tokens) {
			this.byToken.set(token, command);
		}
		return { ok: true };
	}

	lookup(token: string): InteractiveCommand | undefined {
		return this.byToken.get(token);
	}

	list(): readonly InteractiveCommand[] {
		return this.commands;
	}
}

export function commandTokens(command: InteractiveCommand): string[] {
	return [command.name, ...(command.aliases ?? [])];
}

export function findCommand(commands: readonly InteractiveCommand[], token: string): InteractiveCommand | undefined {
	return commands.find((command) => command.name === token || command.aliases?.includes(token));
}

export function createRegistry(commands: readonly InteractiveCommand[]): CommandRegistry {
	const registry = new CommandRegistry();
	for (const command of commands) {
		const result = registry.register(command);
		if (!result.ok) {
			throw new Error(`failed to register ${command.name}: ${result.reason} ${result.detail}`);
		}
	}
	return registry;
}

export async function runCommand(
	command: InteractiveCommand,
	context: CommandContext,
	args: string,
): Promise<CommandRunResult> {
	try {
		return await command.run(context, args);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (context.write) {
			context.write("error", message);
		} else {
			context.tui?.appendNotice("error", message);
		}
		return { kind: "continue", error: true };
	}
}
