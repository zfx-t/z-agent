import type { Agent, AgentEvent, AgentMessage } from "@z-agent/agent";
import { findCommand, runCommand } from "./command-registry.ts";
import type { CommandContext, CommandLevel, InteractiveCommand } from "./command-types.ts";
import { INTERACTIVE_COMMANDS } from "./interactive-commands.ts";
import { userTextMessage } from "./skill-handlers.ts";
import { extractSkillPathHints, type SkillManager } from "./skill-manager.ts";
import { type ParsedInput, parseSlashInput } from "./slash.ts";

export type SkillCommandLevel = CommandLevel;

export type SkillInputResult =
	| { kind: "handled"; error?: boolean }
	| { kind: "request"; message: AgentMessage }
	| { kind: "builtin"; name: string; args: string };

export interface SkillInputCoordinatorOptions {
	agent: Agent;
	manager: SkillManager;
	commands?: readonly InteractiveCommand[];
	write?: (level: SkillCommandLevel, text: string) => void;
	onReload?: () => void;
}

export class SkillInputCoordinator {
	private readonly agent: Agent;
	private readonly manager: SkillManager;
	private readonly commands: readonly InteractiveCommand[];
	private readonly write: (level: SkillCommandLevel, text: string) => void;
	private readonly onReload?: () => void;
	private readonly pending: string[] = [];
	private draining = false;

	constructor(options: SkillInputCoordinatorOptions) {
		this.agent = options.agent;
		this.manager = options.manager;
		this.commands = options.commands ?? INTERACTIVE_COMMANDS;
		this.write = options.write ?? (() => {});
		this.onReload = options.onReload;
	}

	subscribe(): () => void {
		return this.agent.subscribe(async (event: AgentEvent) => {
			if (event.type === "turn_end") {
				await this.drainAtBoundary();
			}
		});
	}

	enqueueDuringRun(line: string): void {
		this.pending.push(line);
		const token = line.trim().split(/\s/u, 1)[0] ?? line.trim();
		this.write("info", `[pending ${this.pending.length}] ${token}`);
	}

	hasPending(): boolean {
		return this.pending.length > 0;
	}

	takePendingAfterIdle(): string | undefined {
		return this.pending.shift();
	}

	async submit(line: string): Promise<SkillInputResult> {
		try {
			return await this.execute(this.parse(line));
		} catch (error) {
			this.write("error", errorMessage(error));
			return { kind: "handled", error: true };
		}
	}

	private parse(line: string): ParsedInput {
		return parseSlashInput(line, this.manager.getIndex(), this.commands);
	}

	private context(): CommandContext {
		return {
			agent: this.agent,
			commands: this.commands,
			write: this.write,
			skills: this.manager,
			onReload: this.onReload,
		};
	}

	private async drainAtBoundary(): Promise<void> {
		if (this.draining) {
			return;
		}
		this.draining = true;
		try {
			while (this.pending.length > 0) {
				const line = this.pending[0];
				if (line === undefined) {
					return;
				}
				const parsed = this.parse(line);
				if (parsed.kind === "builtin") {
					const command = findCommand(this.commands, parsed.name);
					if (!command?.availableDuringRun) {
						return;
					}
				}
				this.pending.shift();
				try {
					const result = await this.execute(parsed, false);
					if (result.kind === "request") {
						this.agent.steer(result.message);
						return;
					}
				} catch (error) {
					this.write("error", errorMessage(error));
				}
			}
		} finally {
			this.draining = false;
		}
	}

	private async execute(parsed: ParsedInput, prepareText = true): Promise<SkillInputResult> {
		if (parsed.kind === "error") {
			this.write("error", parsed.message);
			return { kind: "handled", error: true };
		}
		if (parsed.kind === "text") {
			if (prepareText) {
				await this.manager.prepareSnapshot({
					text: parsed.text,
					pathHints: extractSkillPathHints(parsed.text),
				});
			}
			return { kind: "request", message: userTextMessage(parsed.text) };
		}
		if (parsed.kind === "skill") {
			const snapshot = await this.manager.prepareSnapshot({ explicitName: parsed.name, args: parsed.args });
			this.write("info", `[skill] ${parsed.name} activated for this request`);
			return { kind: "request", message: this.manager.createInvocationMessage(snapshot) };
		}
		const command = findCommand(this.commands, parsed.name);
		if (command?.availableDuringRun) {
			const result = await runCommand(command, this.context(), parsed.args);
			if (result.kind === "request") {
				return { kind: "request", message: result.message };
			}
			if (result.kind === "continue") {
				return { kind: "handled", error: result.error };
			}
		}
		return { kind: "builtin", name: parsed.name, args: parsed.args };
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
