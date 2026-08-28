import type { Agent, AgentEvent, AgentMessage, AgentToolResult } from "@z-agent/agent";
import type { InteractiveTui } from "@z-agent/tui";
import { commandMenuItems, INTERACTIVE_COMMANDS } from "./interactive-commands.ts";
import type { SkillInputCoordinator } from "./skill-commands.ts";

const TOOL_RESULT_PREVIEW_CHARS = 720;

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
	input?: SkillInputCoordinator;
	onNew?: () => Promise<void> | void;
	onReset?: () => Promise<void> | void;
	onCompact?: () => Promise<void>;
	listSessions?: () => Promise<string[]>;
	onLoadSession?: (id: string) => Promise<AgentMessage[]>;
	formatStatus?: () => string;
	onModel?: (args: string) => Promise<void> | void;
}): Promise<void> {
	const unsubscribeInput = options.input?.subscribe();
	const unsubscribe = subscribeTui(options.agent, options.tui);
	options.tui.start();
	if (options.hasModel === false) {
		options.tui.appendNotice("warning", "no model in use");
	}
	try {
		const processLine = async (submitted: string): Promise<"continue" | "exit"> => {
			const result = options.input ? await options.input.submit(submitted) : undefined;
			if (result?.kind === "handled") {
				return "continue";
			}
			if (result?.kind === "request") {
				if (options.hasModel === false) {
					options.tui.appendNotice("warning", "no model in use");
					return "continue";
				}
				try {
					await options.agent.prompt(result.message);
				} catch (error) {
					options.tui.appendNotice("error", error instanceof Error ? error.message : String(error));
				}
				if (options.agent.state.errorMessage) {
					options.tui.appendNotice("error", options.agent.state.errorMessage);
				}
				return "continue";
			}

			const builtin = result?.kind === "builtin" ? result : undefined;
			let line = builtin ? `${builtin.name}${builtin.args ? ` ${builtin.args}` : ""}` : submitted;
			if (line === "/exit" || line === "/quit") {
				return "exit";
			}
			if (line === "/commands" || line === "/help") {
				const index = await options.tui.pickFromList("Commands", commandMenuItems(), { cancelValue: -1 });
				if (index < 0) {
					return "continue";
				}
				line = INTERACTIVE_COMMANDS[index]?.name ?? "/commands";
				return await processLine(line);
			}
			if (line === "/new") {
				if (options.onNew) {
					await options.onNew();
				} else {
					options.agent.reset();
				}
				options.tui.clearTranscript();
				options.tui.appendLine("[new] fresh conversation");
				return "continue";
			}
			if (line === "/reset") {
				if (options.onReset) {
					await options.onReset();
				} else {
					options.agent.reset();
				}
				options.tui.appendLine("[reset]");
				return "continue";
			}
			if (line === "/clear") {
				options.tui.clearTranscript();
				return "continue";
			}
			if (builtin?.name === "/status" || line === "/status") {
				if (options.formatStatus) {
					options.tui.appendLine(options.formatStatus());
				} else {
					options.tui.showStatus();
				}
				return "continue";
			}
			if (builtin?.name === "/model" || line === "/model" || line.startsWith("/model ")) {
				const args = builtin?.args ?? line.slice("/model".length).trim();
				await options.onModel?.(args);
				return "continue";
			}
			if (line === "/compact") {
				await options.onCompact?.();
				options.tui.appendLine("[compact]");
				return "continue";
			}
			if (line === "/sessions" || line === "/resume") {
				const ids = (await options.listSessions?.()) ?? [];
				if (ids.length === 0) {
					options.tui.appendLine("no sessions");
					return "continue";
				}
				const index = await options.tui.pickFromList("Resume session", ids, { cancelValue: -1 });
				if (index < 0 || !options.onLoadSession) {
					return "continue";
				}
				const messages = await options.onLoadSession(ids[index]);
				options.agent.reset();
				options.agent.state.messages = messages;
				options.tui.appendLine(`[sessions] loaded ${ids[index]}`);
				return "continue";
			}
			if (options.hasModel === false) {
				options.tui.appendNotice("warning", "no model in use");
				return "continue";
			}
			try {
				await options.agent.prompt(line);
			} catch (error) {
				options.tui.appendNotice("error", error instanceof Error ? error.message : String(error));
			}
			if (options.agent.state.errorMessage) {
				options.tui.appendNotice("error", options.agent.state.errorMessage);
			}
			return "continue";
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
