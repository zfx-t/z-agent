/**
 * @z-agent/agent — in-memory agent runtime.
 *
 * streamAssistant + runLoop with tool pipeline (prepare → execute → after).
 * Default toolExecution is parallel three-phase; sequential when configured
 * or when any tool sets executionMode sequential.
 * Agent shell: prompt mutex, subscribe, abort, continue (queues in PR 7).
 */

export const AGENT_PACKAGE = "@z-agent/agent" as const;

export type { AgentOptions } from "./agent.ts";
export { Agent } from "./agent.ts";
export { runAgentLoop, runAgentLoopContinue, runLoop } from "./agent-loop.ts";
export type {
	AgentEventCollector,
	AgentEventSink,
} from "./emit.ts";
export {
	composeAgentEventSinks,
	createAgentEventCollector,
	emitAgentEvent,
} from "./emit.ts";
export { streamAssistant } from "./stream-assistant.ts";
export type {
	AfterToolCallContext,
	AfterToolCallResult,
	AgentContext,
	AgentEvent,
	AgentEventType,
	AgentLoopConfig,
	AgentMessage,
	AgentState,
	AgentTool,
	AgentToolCall,
	AgentToolParametersSchema,
	AgentToolResult,
	AgentToolUpdateCallback,
	AssistantMessage,
	AssistantMessageEvent,
	BeforeToolCallContext,
	BeforeToolCallResult,
	CustomAgentMessages,
	ImageContent,
	Message,
	Model,
	QueueMode,
	StreamFn,
	StreamOptions,
	TextContent,
	ToolCall,
	ToolExecutionMode,
	ToolResultMessage,
	Usage,
} from "./types.ts";
