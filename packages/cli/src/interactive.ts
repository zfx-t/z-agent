import type { Agent, AgentEvent, AgentMessage } from "@z-agent/agent";
import type { InteractiveTui } from "@z-agent/tui";

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
			tui.appendLine(`[tool] ${event.toolName}`);
		}
		if (event.type === "tool_execution_end") {
			tui.appendLine(`[tool_end] ${event.toolName} error=${event.isError}`);
		}
	});
}

export async function runInteractive(options: {
	agent: Agent;
	tui: InteractiveTui;
	onCompact?: () => Promise<void>;
	listSessions?: () => Promise<string[]>;
	onLoadSession?: (id: string) => Promise<AgentMessage[]>;
}): Promise<void> {
	const unsubscribe = subscribeTui(options.agent, options.tui);
	options.tui.start();
	try {
		while (true) {
			const line = await options.tui.readPrompt();
			if (line === null || line === "/exit" || line === "/quit") {
				break;
			}
			if (line === "/reset") {
				options.agent.reset();
				options.tui.appendLine("[reset]");
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
					options.tui.appendLine("[sessions] none");
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
			try {
				await options.agent.prompt(line);
			} catch (error) {
				options.tui.appendLine(`[error] ${error instanceof Error ? error.message : String(error)}`);
			}
			if (options.agent.state.errorMessage) {
				options.tui.appendLine(`[error] ${options.agent.state.errorMessage}`);
			}
		}
	} finally {
		unsubscribe();
		options.tui.close();
	}
}
