import type { Agent, AgentMessage } from "@z-agent/agent";
import type { InteractiveTui } from "@z-agent/tui";
import type { SessionInspectResult } from "./sessions.ts";
import type { SkillManager } from "./skill-manager.ts";

export type CommandSource = "builtin" | { extension: string };

export type CommandLevel = "info" | "warning" | "error";

export type CommandRunResult =
	| { kind: "continue"; error?: boolean }
	| { kind: "exit" }
	| { kind: "request"; message: AgentMessage }
	| { kind: "reprocess"; line: string };

export interface CommandContext {
	agent: Agent;
	commands: readonly InteractiveCommand[];
	tui?: InteractiveTui;
	hasModel?: boolean;
	onNew?: () => Promise<void> | void;
	onReset?: () => Promise<void> | void;
	onCompact?: () => Promise<void>;
	listSessions?: () => Promise<string[]>;
	onLoadSession?: (id: string) => Promise<AgentMessage[]>;
	onInspectSession?: (id: string) => Promise<SessionInspectResult>;
	onRestoreCheckpoint?: (sessionId: string, nodeId: string | undefined) => Promise<AgentMessage[]>;
	formatStatus?: () => string;
	onModel?: (args: string) => Promise<void> | void;
	write?: (level: CommandLevel, text: string) => void;
	skills?: SkillManager;
	onReload?: () => void;
}

export interface InteractiveCommand {
	name: string;
	description: string;
	source: CommandSource;
	aliases?: readonly string[];
	/** When true, the coordinator may run this command at a turn boundary. */
	availableDuringRun?: boolean;
	validate?(args: string): string | undefined;
	run(context: CommandContext, args: string): Promise<CommandRunResult>;
}
