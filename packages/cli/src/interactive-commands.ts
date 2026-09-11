/** Built-in interactive commands, inspired by PI's slash registry and OpenCode's command palette. */
import type { CommandContext, CommandRunResult, InteractiveCommand } from "./command-types.ts";
import { parseModelCommand } from "./model-settings.ts";
import { formatCheckpointRow, formatSessionHealth } from "./sessions.ts";
import { runReloadCommand, runSkillCommand, runSkillsCommand } from "./skill-handlers.ts";
import { replayTranscript } from "./transcript.ts";

export type {
	CommandContext,
	CommandLevel,
	CommandRunResult,
	CommandSource,
	InteractiveCommand,
} from "./command-types.ts";

function isSkillMode(value: string | undefined): boolean {
	return value === "progressive" || value === "full" || value === "index";
}

function validateSkillArgs(args: string): string | undefined {
	if (args.length === 0) {
		return "Usage: /skill <name> [args], /skill -<name>, or /skill all";
	}
	if (args === "-") {
		return "Usage: /skill -<name>";
	}
	return undefined;
}

function validateSkillsArgs(args: string): string | undefined {
	if (args === "mode" || args.startsWith("mode ")) {
		const parts = args.split(/\s+/u);
		if (parts.length !== 2 || !isSkillMode(parts[1])) {
			return "Usage: /skills mode progressive|full|index";
		}
	}
	return undefined;
}

function validateModelArgs(args: string): string | undefined {
	const parsed = parseModelCommand(args);
	return parsed.kind === "error" ? parsed.message : undefined;
}

async function runNew(context: CommandContext): Promise<CommandRunResult> {
	if (context.onNew) {
		await context.onNew();
	} else {
		context.agent.reset();
	}
	context.tui?.clearTranscript();
	context.tui?.appendLine("[new] fresh conversation");
	return { kind: "continue" };
}

async function runReset(context: CommandContext): Promise<CommandRunResult> {
	if (context.onReset) {
		await context.onReset();
	} else {
		context.agent.reset();
	}
	context.tui?.appendLine("[reset]");
	return { kind: "continue" };
}

async function runClear(context: CommandContext): Promise<CommandRunResult> {
	context.tui?.clearTranscript();
	return { kind: "continue" };
}

async function runCompact(context: CommandContext): Promise<CommandRunResult> {
	await context.onCompact?.();
	context.tui?.appendLine("[compact]");
	return { kind: "continue" };
}

async function runStatus(context: CommandContext): Promise<CommandRunResult> {
	if (context.formatStatus) {
		context.tui?.appendLine(context.formatStatus());
	} else {
		context.tui?.showStatus();
	}
	return { kind: "continue" };
}

async function runModel(context: CommandContext, args: string): Promise<CommandRunResult> {
	await context.onModel?.(args);
	return { kind: "continue" };
}

async function runCommands(context: CommandContext): Promise<CommandRunResult> {
	if (!context.tui) {
		return { kind: "continue" };
	}
	const index = await context.tui.pickFromList("Commands", commandMenuItems(context.commands), { cancelValue: -1 });
	if (index < 0) {
		return { kind: "continue" };
	}
	return { kind: "reprocess", line: context.commands[index]?.name ?? "/commands" };
}

async function runSessions(context: CommandContext): Promise<CommandRunResult> {
	if (!context.tui) {
		return { kind: "continue" };
	}
	const ids = (await context.listSessions?.()) ?? [];
	if (ids.length === 0) {
		context.tui.appendLine("no sessions");
		return { kind: "continue" };
	}
	const index = await context.tui.pickFromList("Resume session", ids, { cancelValue: -1 });
	if (index < 0) {
		return { kind: "continue" };
	}
	const sessionId = ids[index];
	if (!sessionId) {
		return { kind: "continue" };
	}
	if (context.onInspectSession && context.onRestoreCheckpoint) {
		const inspect = await context.onInspectSession(sessionId);
		if (!inspect.ok) {
			context.tui.appendNotice("error", `[sessions] ${formatSessionHealth(inspect)}`);
			return { kind: "continue" };
		}
		let nodeId: string | undefined;
		let restoredLabel = "leaf";
		if (inspect.checkpoints.length > 0) {
			const pick = await context.tui.pickFromList(
				"Restore checkpoint",
				inspect.checkpoints.map(formatCheckpointRow),
				{ cancelValue: -1 },
			);
			if (pick < 0) {
				return { kind: "continue" };
			}
			const checkpoint = inspect.checkpoints[pick];
			if (!checkpoint) {
				return { kind: "continue" };
			}
			nodeId = checkpoint.id;
			restoredLabel = formatCheckpointRow(checkpoint);
		}
		const messages = await context.onRestoreCheckpoint(sessionId, nodeId);
		context.agent.reset();
		context.agent.state.messages = messages;
		context.tui.clearTranscript();
		replayTranscript(context.tui, messages);
		context.tui.appendLine(`[sessions] restored ${sessionId} at ${restoredLabel}`);
		return { kind: "continue" };
	}
	if (!context.onLoadSession) {
		return { kind: "continue" };
	}
	const messages = await context.onLoadSession(sessionId);
	context.agent.reset();
	context.agent.state.messages = messages;
	context.tui.clearTranscript();
	replayTranscript(context.tui, messages);
	context.tui.appendLine(`[sessions] loaded ${sessionId}`);
	return { kind: "continue" };
}

export const INTERACTIVE_COMMANDS: readonly InteractiveCommand[] = [
	{ name: "/new", description: "Start a fresh conversation", source: "builtin", run: runNew },
	{ name: "/reset", description: "Reset agent context", source: "builtin", run: runReset },
	{ name: "/clear", description: "Clear visible transcript", source: "builtin", run: runClear },
	{ name: "/compact", description: "Compact the active context", source: "builtin", run: runCompact },
	{
		name: "/sessions",
		description: "Browse sessions and restore a checkpoint",
		source: "builtin",
		aliases: ["/resume"],
		run: runSessions,
	},
	{ name: "/status", description: "Show runtime status", source: "builtin", run: runStatus },
	{
		name: "/model",
		description: "Show or set model context and parameters",
		source: "builtin",
		validate: validateModelArgs,
		run: runModel,
	},
	{
		name: "/commands",
		description: "Browse available commands",
		source: "builtin",
		aliases: ["/help"],
		run: runCommands,
	},
	{
		name: "/skills",
		description: "List skills or change context mode",
		source: "builtin",
		availableDuringRun: true,
		validate: validateSkillsArgs,
		run: runSkillsCommand,
	},
	{
		name: "/skill",
		description: "Activate or deactivate a skill",
		source: "builtin",
		availableDuringRun: true,
		validate: validateSkillArgs,
		run: runSkillCommand,
	},
	{
		name: "/reload",
		description: "Reload local skills",
		source: "builtin",
		availableDuringRun: true,
		run: runReloadCommand,
	},
	{
		name: "/exit",
		description: "Exit z-agent",
		source: "builtin",
		aliases: ["/quit"],
		run: async () => ({ kind: "exit" }),
	},
];

export function commandMenuItems(commands: readonly InteractiveCommand[] = INTERACTIVE_COMMANDS): string[] {
	const longest = Math.max(...commands.map((command) => command.name.length));
	return commands.map((command) => `${command.name.padEnd(longest)}  ${command.description}`);
}
