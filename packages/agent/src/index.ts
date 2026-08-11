/**
 * @z-agent/agent — in-memory agent runtime.
 *
 * PR 4 surface: streamAssistant + runLoop with sequential tool pipeline
 * (prepare → execute → after). Parallel tools, Agent shell, queues later.
 */

export const AGENT_PACKAGE = "@z-agent/agent" as const;

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
