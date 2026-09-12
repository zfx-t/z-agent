/**
 * @z-agent/agent — in-memory agent runtime.
 *
 * streamAssistant + runLoop with tool pipeline (prepare → execute → after).
 * Default toolExecution is parallel three-phase; sequential when configured
 * or when any tool sets executionMode sequential.
 * Agent shell: prompt mutex, subscribe, abort, continue, steer / followUp queues.
 * Context hooks: prepareContext, transformContext, prepareNextTurn, shouldStopAfterTurn.
 * Queue hooks: prepareQueuedMessages at steering/follow-up safe boundaries.
 * thinkingLevel. agentLoop EventStream.
 */

export const AGENT_PACKAGE = "@z-agent/agent" as const;

export type { AgentOptions } from "./agent.ts";
export { Agent } from "./agent.ts";
export { agentLoop, agentLoopContinue, runAgentLoop, runAgentLoopContinue, runLoop } from "./agent-loop.ts";
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
export { agentToolsToLlmTools } from "./tool-json-schema.ts";
export type {
	AllToolsOptions,
	BashEnvPolicy,
	BashTimeoutPolicy,
	BashToolOptions,
	CodingToolsOptions,
} from "./tools/index.ts";
export {
	applyEdits,
	assertInsideJail,
	buildChildEnv,
	createAllTools,
	createBashTool,
	createCodingTools,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	DEFAULT_BASH_ENV_POLICY,
	DEFAULT_BASH_TIMEOUT,
	detectImageMimeType,
	killProcessTree,
	resolveTimeoutMs,
	resolveToCwd,
	win32TaskkillArgs,
	withFileMutationQueue,
} from "./tools/index.ts";
export type {
	AfterToolCallContext,
	AfterToolCallResult,
	AgentContext,
	AgentEvent,
	AgentEventType,
	AgentLoopConfig,
	AgentLoopTurnUpdate,
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
	PrepareNextTurnContext,
	QueueMode,
	ShouldStopAfterTurnContext,
	StreamFn,
	StreamOptions,
	TextContent,
	ThinkingLevel,
	ToolCall,
	ToolExecutionMode,
	ToolResultMessage,
	Usage,
} from "./types.ts";
