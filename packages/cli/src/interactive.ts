import type { Agent, AgentEvent, AgentMessage } from "@z-agent/agent";
import type { InteractiveTui } from "@z-agent/tui";
import { type CommandRegistry, createRegistry, runCommand } from "./command-registry.ts";
import type { CommandContext } from "./command-types.ts";
import { INTERACTIVE_COMMANDS } from "./interactive-commands.ts";
import type { SessionInspectResult } from "./sessions.ts";
import type { SkillInputCoordinator } from "./skill-commands.ts";
import { parseSlashInput } from "./slash.ts";
import { compactDetails, toolResultPreview } from "./transcript.ts";

export function submitTuiInputDuringRun(
	target: Pick<Agent, "steer"> | Pick<SkillInputCoordinator, "enqueueDuringRun">,
	text: string,
): void {
	if ("enqueueDuringRun" in target) {
		target.enqueueDuringRun(text);
		return;
	}
	target.steer({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
}

export function subscribeTui(agent: Agent, tui: InteractiveTui): () => void {
	return agent.subscribe((event: AgentEvent) => {
		if (event.type === "agent_start") {
			tui.setStreaming(true);
		}
		if (event.type === "agent_end") {
			tui.setStreaming(false);
		}
		if (event.type === "message_update") {
			const ev = event.assistantMessageEvent;
			if (ev.type === "text_delta") {
				tui.appendAssistantDelta(ev.delta);
			} else if (ev.type === "thinking_delta") {
				tui.appendThinkingDelta(ev.delta);
			}
		}
		if (event.type === "tool_execution_start") {
			tui.appendToolStart(event.toolCallId, event.toolName, event.args);
		}
		if (event.type === "tool_execution_update") {
			tui.appendToolUpdate(event.toolCallId, {
				outputText: toolResultPreview(event.partialResult),
				detailsText: compactDetails(event.partialResult.details),
			});
		}
		if (event.type === "tool_execution_end") {
			tui.appendToolEnd(
				event.toolCallId,
				toolResultPreview(event.result),
				event.isError,
				compactDetails(event.result.details),
			);
		}
	});
}

export async function runInteractive(options: {
	agent: Agent;
	tui: InteractiveTui;
	hasModel?: boolean;
	input?: SkillInputCoordinator;
	registry?: CommandRegistry;
	onNew?: () => Promise<void> | void;
	onReset?: () => Promise<void> | void;
	onCompact?: () => Promise<void>;
	listSessions?: () => Promise<string[]>;
	onLoadSession?: (id: string) => Promise<AgentMessage[]>;
	onInspectSession?: (id: string) => Promise<SessionInspectResult>;
	onRestoreCheckpoint?: (sessionId: string, nodeId: string | undefined) => Promise<AgentMessage[]>;
	formatStatus?: () => string;
	onModel?: (args: string) => Promise<void> | void;
}): Promise<void> {
	const unsubscribeInput = options.input?.subscribe();
	const unsubscribe = subscribeTui(options.agent, options.tui);
	const registry = options.registry ?? createRegistry(INTERACTIVE_COMMANDS);
	options.tui.start();
	if (options.hasModel === false) {
		options.tui.appendNotice("warning", "no model in use");
	}
	const context = (): CommandContext => ({
		agent: options.agent,
		commands: registry.list(),
		tui: options.tui,
		hasModel: options.hasModel,
		onNew: options.onNew,
		onReset: options.onReset,
		onCompact: options.onCompact,
		listSessions: options.listSessions,
		onLoadSession: options.onLoadSession,
		onInspectSession: options.onInspectSession,
		onRestoreCheckpoint: options.onRestoreCheckpoint,
		formatStatus: options.formatStatus,
		onModel: options.onModel,
	});
	try {
		const processLine = async (submitted: string): Promise<"continue" | "exit"> => {
			const result = options.input ? await options.input.submit(submitted) : undefined;
			if (result?.kind === "handled") {
				return "continue";
			}
			if (result?.kind === "request") {
				return await promptAgent(options, result.message);
			}
			if (result?.kind === "exit") {
				return "exit";
			}
			if (result?.kind === "reprocess") {
				return await processLine(result.line);
			}

			let name: string | undefined;
			let args = "";
			if (result?.kind === "builtin") {
				name = result.name;
				args = result.args;
			} else if (!options.input) {
				const parsed = parseSlashInput(submitted, { byName: new Map() }, registry.list());
				if (parsed.kind === "error") {
					options.tui.appendNotice("error", parsed.message);
					return "continue";
				}
				if (parsed.kind === "builtin") {
					name = parsed.name;
					args = parsed.args;
				}
			}

			if (name) {
				const command = registry.lookup(name);
				if (command) {
					const outcome = await runCommand(command, context(), args);
					if (outcome.kind === "exit") {
						return "exit";
					}
					if (outcome.kind === "reprocess") {
						return await processLine(outcome.line);
					}
					if (outcome.kind === "request") {
						return await promptAgent(options, outcome.message);
					}
					return "continue";
				}
			}

			return await promptAgent(options, submitted);
		};

		let pendingLine: string | undefined;
		while (true) {
			const line = pendingLine ?? (await options.tui.readPrompt());
			pendingLine = undefined;
			if (line === null || (await processLine(line)) === "exit") {
				break;
			}
			pendingLine = options.input?.takePendingAfterIdle();
		}
	} finally {
		unsubscribeInput?.();
		unsubscribe();
		options.tui.close();
	}
}

async function promptAgent(
	options: {
		agent: Agent;
		tui: InteractiveTui;
		hasModel?: boolean;
	},
	input: string | AgentMessage,
): Promise<"continue"> {
	if (options.hasModel === false) {
		options.tui.appendNotice("warning", "no model in use");
		return "continue";
	}
	try {
		if (typeof input === "string") {
			await options.agent.prompt(input);
		} else {
			await options.agent.prompt(input);
		}
	} catch (error) {
		options.tui.appendNotice("error", error instanceof Error ? error.message : String(error));
	}
	if (options.agent.state.errorMessage) {
		options.tui.appendNotice("error", options.agent.state.errorMessage);
	}
	return "continue";
}
