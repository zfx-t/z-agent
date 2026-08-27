import type { Agent, AgentEvent, AgentMessage, AgentToolResult } from "@z-agent/agent";
import type { InteractiveTui } from "@z-agent/tui";
import { commandMenuItems, INTERACTIVE_COMMANDS } from "./interactive-commands.ts";

const TOOL_RESULT_PREVIEW_CHARS = 720;

export function submitTuiInputDuringRun(agent: Pick<Agent, "steer">, text: string): void {
	agent.steer({
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	});
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

function toolResultPreview(result: AgentToolResult): string {
	const text = result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("")
		.trim();
	return text.length <= TOOL_RESULT_PREVIEW_CHARS ? text : `${text.slice(0, TOOL_RESULT_PREVIEW_CHARS)}...`;
}

function compactDetails(details: unknown): string | undefined {
	if (details === undefined || details === null) {
		return undefined;
	}
	let text: string;
	try {
		text = JSON.stringify(details) ?? "";
	} catch {
		text = String(details);
	}
	return text.length <= 520 ? text : `${text.slice(0, 520)}...`;
}

export async function runInteractive(options: {
	agent: Agent;
	tui: InteractiveTui;
	hasModel?: boolean;
	onNew?: () => Promise<void> | void;
	onCompact?: () => Promise<void>;
	listSessions?: () => Promise<string[]>;
	onLoadSession?: (id: string) => Promise<AgentMessage[]>;
}): Promise<void> {
	const unsubscribe = subscribeTui(options.agent, options.tui);
	options.tui.start();
	if (options.hasModel === false) {
		options.tui.appendNotice("warning", "no model in use");
	}
	try {
		while (true) {
			let line = await options.tui.readPrompt();
			if (line === null || line === "/exit" || line === "/quit") {
				break;
			}
			if (line === "/commands" || line === "/help") {
				const index = await options.tui.pickFromList("Commands", commandMenuItems(), { cancelValue: -1 });
				if (index < 0) {
					continue;
				}
				line = INTERACTIVE_COMMANDS[index]?.name ?? "/commands";
			}
			if (line === "/exit" || line === "/quit") {
				break;
			}
			if (line === "/new") {
				if (options.onNew) {
					await options.onNew();
				} else {
					options.agent.reset();
				}
				options.tui.clearTranscript();
				options.tui.appendLine("[new] fresh conversation");
				continue;
			}
			if (line === "/reset") {
				options.agent.reset();
				options.tui.appendLine("[reset]");
				continue;
			}
			if (line === "/clear") {
				options.tui.clearTranscript();
				continue;
			}
			if (line === "/status") {
				options.tui.showStatus();
				continue;
			}
			if (line === "/compact") {
				await options.onCompact?.();
				options.tui.appendLine("[compact]");
				continue;
			}
			if (line === "/sessions" || line === "/resume") {
				const ids = (await options.listSessions?.()) ?? [];
				if (ids.length === 0) {
					options.tui.appendLine("no sessions");
					continue;
				}
				const index = await options.tui.pickFromList("Resume session", ids, { cancelValue: -1 });
				if (index < 0 || !options.onLoadSession) {
					continue;
				}
				const messages = await options.onLoadSession(ids[index]);
				options.agent.reset();
				options.agent.state.messages = messages;
				options.tui.appendLine(`[sessions] loaded ${ids[index]}`);
				continue;
			}
			if (options.hasModel === false) {
				options.tui.appendNotice("warning", "no model in use");
				continue;
			}
			try {
				await options.agent.prompt(line);
			} catch (error) {
				options.tui.appendNotice("error", error instanceof Error ? error.message : String(error));
			}
			if (options.agent.state.errorMessage) {
				options.tui.appendNotice("error", options.agent.state.errorMessage);
			}
		}
	} finally {
		unsubscribe();
		options.tui.close();
	}
}
