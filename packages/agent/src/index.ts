/**
 * @z-agent/agent — in-memory agent runtime.
 *
 * PR 2 surface: AgentMessage, AgentEvent, AgentContext, zod tools, emit sink.
 * runLoop / streamAssistant land in later PRs (see docs/design.md).
 */

export const AGENT_PACKAGE = "@z-agent/agent" as const;

export type {
	AgentEventCollector,
	AgentEventSink,
} from "./emit.ts";
export {
	composeAgentEventSinks,
	createAgentEventCollector,
	emitAgentEvent,
} from "./emit.ts";
export type {
	AfterToolCallResult,
	AgentContext,
	AgentEvent,
	AgentEventType,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	AgentToolUpdateCallback,
	AssistantMessage,
	AssistantMessageEvent,
	BeforeToolCallResult,
	CustomAgentMessages,
	ImageContent,
	Message,
	QueueMode,
	TextContent,
	ToolCall,
	ToolExecutionMode,
	ToolResultMessage,
	Usage,
} from "./types.ts";
