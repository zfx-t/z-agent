/**
 * @z-agent/agent — in-memory agent runtime.
 *
 * PR 3 surface: streamAssistant + runLoop (tools deferred), AgentLoopConfig.
 * Tool execution, Agent shell, and queues land in later PRs (see docs/design.md).
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
