/**
 * Agent-layer types for @z-agent/agent.
 *
 * Dual message layer (ADR-0006): AgentMessage is the application transcript;
 * LLM {@link Message} from @z-agent/ai is produced only via convertToLlm at the
 * provider boundary (streamAssistant).
 *
 * Event names/semantics align with the pi agent-loop oracle (ADR-0008).
 * Tool parameter schemas use zod (ADR-0013), not typebox.
 */

import type {
	AssistantMessage,
	AssistantMessageEvent,
	ImageContent,
	Message,
	Model,
	StreamFn,
	StreamOptions,
	TextContent,
	ThinkingLevel,
	ToolCall,
	ToolResultMessage,
	Usage,
} from "@z-agent/ai";
import type { z } from "zod";

// ---------------------------------------------------------------------------
// Queue + tool execution modes
// ---------------------------------------------------------------------------

/**
 * How many queued messages are injected at a drain point.
 *
 * - `"all"`: drain every queued message
 * - `"one-at-a-time"`: drain only the oldest; leave the rest for later points
 *
 * Defaults: steering and follow-up use `"one-at-a-time"`.
 */
export type QueueMode = "all" | "one-at-a-time";

/**
 * How tool calls from a single assistant message are executed.
 *
 * - `"sequential"`: prepare → execute → finalize each call before the next
 * - `"parallel"`: prepare all sequentially, execute allowed concurrently;
 *   `tool_execution_end` in completion order; toolResult artifacts in source order
 *
 * Default (when tools land): `"parallel"`.
 */
export type ToolExecutionMode = "sequential" | "parallel";

// ---------------------------------------------------------------------------
// Dual message layer (ADR-0006)
// ---------------------------------------------------------------------------

/**
 * Extensible surface for custom app messages.
 * Apps extend via declaration merging:
 *
 * @example
 * ```typescript
 * declare module "@z-agent/agent" {
 *   interface CustomAgentMessages {
 *     notification: { role: "notification"; text: string; timestamp: number };
 *   }
 * }
 * ```
 */
export interface CustomAgentMessages {
	// Empty by default — apps extend via declaration merging
}

/**
 * Application transcript message: LLM {@link Message} plus optional custom roles.
 * Owns emit / queues / future durable entries. Never sent to the provider as-is;
 * non-LLM roles are filtered or mapped by convertToLlm.
 */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

// ---------------------------------------------------------------------------
// Tools (zod parameters — ADR-0013)
// ---------------------------------------------------------------------------

/** A single toolCall content block from an assistant message. */
export type AgentToolCall = ToolCall;

/** Final or partial result produced by a tool. */
export interface AgentToolResult<TDetails = unknown> {
	/** Text or image content returned to the model. */
	content: (TextContent | ImageContent)[];
	/** Arbitrary structured details for logs or UI rendering. */
	details: TDetails;
	/** Usage from the tool execution itself, if available. Not for main LLM accounting. */
	usage?: Usage;
	/** Names of tools introduced by this result and available from this transcript point onward. */
	addedToolNames?: string[];
	/**
	 * Hint that the agent should stop after the current tool batch.
	 * Early termination only when every finalized result in the batch sets this true.
	 */
	terminate?: boolean;
}

/**
 * Callback used by tools to stream partial execution updates.
 * Scoped to the current `execute()` invocation; late calls after settle are ignored (later PRs).
 */
export type AgentToolUpdateCallback<TDetails = unknown> = (partialResult: AgentToolResult<TDetails>) => void;

/**
 * Default zod schema bound for unparameterized {@link AgentTool}.
 * Preserves `unknown` for input/output (avoids `z.ZodType` defaulting to `any`).
 */
export type AgentToolParametersSchema = z.ZodType<unknown, z.ZodTypeDef, unknown>;

/**
 * Tool definition for the agent runtime.
 *
 * `parameters` is a **zod** schema (ADR-0013). Conversion to JSON-Schema-shaped
 * {@link import("@z-agent/ai").Tool} happens in streamAssistant via agentToolsToLlmTools.
 *
 * **Method syntax** for `execute` / `prepareArguments` is intentional: under
 * `strictFunctionTypes`, property functions are contravariant in parameters, so a
 * concrete `AgentTool<ZodObject<…>>` would not be assignable to `AgentTool[]`.
 * Interface methods are checked bivariantly, which is the correct bag typing for
 * heterogeneous tool registries (loop always validates args before calling execute).
 */
export interface AgentTool<
	TParameters extends AgentToolParametersSchema = AgentToolParametersSchema,
	TDetails = unknown,
> {
	name: string;
	description: string;
	/** Zod schema for tool arguments. */
	parameters: TParameters;
	/** Human-readable label for UI display. */
	label: string;
	/**
	 * Optional shim for raw tool-call arguments before schema validation.
	 * Must return a value that matches `TParameters` input.
	 */
	prepareArguments?(args: unknown): z.input<TParameters>;
	/**
	 * Execute the tool call (sole tool-body effect boundary — ADR-0010).
	 * Throw on failure instead of encoding errors in `content`.
	 */
	execute(
		toolCallId: string,
		params: z.output<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	): Promise<AgentToolResult<TDetails>>;
	/**
	 * Per-tool execution mode override.
	 * If omitted, the run-level default applies.
	 */
	executionMode?: ToolExecutionMode;
}

// ---------------------------------------------------------------------------
// before / after tool hooks
// ---------------------------------------------------------------------------

/**
 * Result from `beforeToolCall`.
 * `{ block: true }` prevents execute; loop emits an error toolResult instead.
 */
export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
	/**
	 * Hint that the agent should stop after the current tool batch when blocked.
	 * Early termination only when every finalized result in the batch sets this true.
	 */
	terminate?: boolean;
}

/**
 * Partial override from `afterToolCall`.
 * Field-by-field replace; omitted fields keep original values; no deep merge.
 */
export interface AfterToolCallResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	isError?: boolean;
	usage?: Usage;
	terminate?: boolean;
}

/** Context passed to `beforeToolCall` (after zod validation). */
export interface BeforeToolCallContext {
	/** The assistant message that requested the tool call. */
	assistantMessage: AssistantMessage;
	/** The raw tool call block from `assistantMessage.content`. */
	toolCall: AgentToolCall;
	/** Validated tool arguments (zod output). */
	args: unknown;
	/** Current agent context at prepare time. */
	context: AgentContext;
}

/** Context passed to `afterToolCall` (before tool_execution_end / toolResult emit). */
export interface AfterToolCallContext {
	/** The assistant message that requested the tool call. */
	assistantMessage: AssistantMessage;
	/** The raw tool call block from `assistantMessage.content`. */
	toolCall: AgentToolCall;
	/** Validated tool arguments used for execute. */
	args: unknown;
	/** The executed tool result before any `afterToolCall` overrides. */
	result: AgentToolResult;
	/** Whether the executed result is currently treated as an error. */
	isError: boolean;
	/** Current agent context at finalize time. */
	context: AgentContext;
}

/** Context passed to `shouldStopAfterTurn`. */
export interface ShouldStopAfterTurnContext {
	/** The assistant message that completed the turn. */
	message: AssistantMessage;
	/** Tool result messages passed to the preceding `turn_end` event. */
	toolResults: ToolResultMessage[];
	/** Current agent context after the turn's assistant message and tool results have been appended. */
	context: AgentContext;
	/**
	 * Messages this loop invocation will return if it exits here.
	 * Prompt runs include the initial prompts; continuations do not include pre-existing context.
	 */
	newMessages: AgentMessage[];
}

/** Replacement runtime state used by the agent loop before starting another provider request. */
export interface AgentLoopTurnUpdate {
	/** Context for the next provider request. */
	context?: AgentContext;
	/** Model for the next provider request. */
	model?: Model;
	/** Thinking level for the next provider request. */
	thinkingLevel?: ThinkingLevel;
}

export interface PrepareNextTurnContext extends ShouldStopAfterTurnContext {}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** Context snapshot for a run (transcript + tools + system prompt). */
export interface AgentContext {
	/** System prompt included with the provider request. */
	systemPrompt: string;
	/** Transcript visible at the agent layer (AgentMessage). */
	messages: AgentMessage[];
	/** Tools available for this run. */
	tools?: AgentTool[];
}

// ---------------------------------------------------------------------------
// Agent shell state (PR 6)
// ---------------------------------------------------------------------------

/**
 * Live agent shell state.
 *
 * `tools` and `messages` use accessor properties so implementations can copy
 * assigned arrays before storing them.
 */
export interface AgentState {
	/** System prompt sent with each model request. */
	systemPrompt: string;
	/** Active model used for future turns. */
	model: Model;
	/** Requested reasoning level for future turns. */
	thinkingLevel: ThinkingLevel;
	/** Available tools. Assigning a new array copies the top-level array. */
	set tools(tools: AgentTool[]);
	get tools(): AgentTool[];
	/** Conversation transcript. Assigning a new array copies the top-level array. */
	set messages(messages: AgentMessage[]);
	get messages(): AgentMessage[];
	/**
	 * True while the agent is processing a prompt or continuation.
	 *
	 * Remains true until awaited `agent_end` listeners settle.
	 */
	readonly isStreaming: boolean;
	/** Partial assistant message for the current streamed response, if any. */
	readonly streamingMessage?: AgentMessage;
	/** Tool call ids currently executing. */
	readonly pendingToolCalls: ReadonlySet<string>;
	/** Error message from the most recent failed or aborted assistant turn, if any. */
	readonly errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Loop config (streamAssistant / runLoop)
// ---------------------------------------------------------------------------

/**
 * Configuration for {@link import("./agent-loop.ts").runAgentLoop} /
 * {@link import("./stream-assistant.ts").streamAssistant}.
 *
 * `convertToLlm` is required (ADR-0006 dual message layer). Provider options
 * (`apiKey`, `temperature`, …) are forwarded into {@link StreamFn}.
 *
 * Tool hooks: prepare (zod + beforeToolCall) → execute → afterToolCall (ADR-0009).
 * toolExecution defaults to `"parallel"` (three-phase).
 * Queue drains: {@link AgentLoopConfig.getSteeringMessages} after each turn;
 * {@link AgentLoopConfig.getFollowUpMessages} when the agent would otherwise stop.
 */
export interface AgentLoopConfig {
	/** Model used for the next provider request. */
	model: Model;

	/** Reasoning effort forwarded to StreamFn. Omit (or leave unset) for `"off"`. */
	reasoning?: StreamOptions["reasoning"];

	/**
	 * Converts AgentMessage[] → LLM Message[] before each provider call.
	 *
	 * Filter UI-only / custom roles; map custom roles to user/assistant/toolResult.
	 * Contract: must not throw or reject — return a safe fallback instead.
	 */
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	/**
	 * Optional AgentMessage-level transform before `convertToLlm`
	 * (pruning, inject context). Must not throw or reject.
	 *
	 * Treat `messages` as read-only. When pruning or injecting, return a **new** array;
	 * in-place mutation (`splice` / `pop` on the input) rewrites the live transcript
	 * because the loop may pass `context.messages` by reference.
	 */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => AgentMessage[] | Promise<AgentMessage[]>;

	/**
	 * Resolves an API key per provider call (expiring OAuth tokens).
	 * Must not throw; return undefined when unavailable.
	 */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

	/**
	 * How tool calls from one assistant message are executed.
	 * - `"sequential"`: prepare → execute → finalize each call before the next
	 * - `"parallel"`: prepare all sequentially, execute allowed concurrently;
	 *   `tool_execution_end` in completion order; toolResult artifacts in source order
	 *
	 * Default: `"parallel"`. Forced sequential when any tool has `executionMode: "sequential"`.
	 */
	toolExecution?: ToolExecutionMode;

	/**
	 * Called after zod validation, before `tool.execute`.
	 * Return `{ block: true }` to skip execute and emit an error toolResult.
	 * Contract: must not throw; honor `signal` when provided.
	 */
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;

	/**
	 * Called after execute (or when after would run on a prepared call), before
	 * `tool_execution_end` and toolResult message events.
	 * Field-by-field overrides; omitted fields keep original values.
	 * Contract: must not throw (throws become error toolResults); honor `signal`.
	 */
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;

	/**
	 * Called after each turn fully completes and `turn_end` has been emitted.
	 *
	 * If it returns true, the loop emits `agent_end` and exits before polling steering
	 * or follow-up queues. Contract: must not throw or reject.
	 */
	shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;

	/**
	 * Called after `turn_end` and before `shouldStopAfterTurn`.
	 * Return replacement context/model/thinking state for later turns in this run.
	 */
	prepareNextTurn?: (
		context: PrepareNextTurnContext,
	) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;

	/**
	 * Returns steering messages to inject mid-run.
	 *
	 * Called at loop start and after each turn completes (tools finished, `turn_end`
	 * emitted). Returned messages are injected with `message_start`/`message_end`
	 * before the next assistant stream. Tool calls from the current turn are not skipped.
	 *
	 * Contract: must not throw or reject. Return `[]` when nothing is pending.
	 */
	getSteeringMessages?: () => Promise<AgentMessage[]>;

	/**
	 * Returns follow-up messages when the agent would otherwise stop.
	 *
	 * Called only after the inner loop exits (no more tool calls and no steering left).
	 * If messages are returned, they are injected and the outer loop continues.
	 *
	 * Contract: must not throw or reject. Return `[]` when nothing is pending.
	 */
	getFollowUpMessages?: () => Promise<AgentMessage[]>;

	/** Optional StreamOptions fields forwarded to StreamFn (signal is separate). */
	apiKey?: string;
	temperature?: number;
	maxTokens?: number;
	sessionId?: string;
	samplingParams?: StreamOptions["samplingParams"];
}

/** Re-export StreamFn for agent consumers configuring the loop. */
export type { StreamFn };

// ---------------------------------------------------------------------------
// Events (pi agent-loop names / semantics)
// ---------------------------------------------------------------------------

/**
 * Lifecycle events emitted by the agent loop for UI / subscribers.
 *
 * Order (typical successful tool turn):
 * `agent_start` → `turn_start` → message lifecycle → tool_execution_* →
 * toolResult message lifecycle → `turn_end` → … → `agent_end`
 *
 * `agent_end` is the last event for a run; awaited subscribers may still settle after it.
 */
export type AgentEvent =
	// Agent lifecycle
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	// Turn lifecycle — one assistant response + any tool calls/results
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	// Message lifecycle — user, assistant, toolResult
	| { type: "message_start"; message: AgentMessage }
	// Assistant streaming only
	| {
			type: "message_update";
			message: AgentMessage;
			assistantMessageEvent: AssistantMessageEvent;
	  }
	| { type: "message_end"; message: AgentMessage }
	// Tool execution lifecycle
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			args: unknown;
			partialResult: AgentToolResult;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: AgentToolResult;
			isError: boolean;
	  };

/** Event type discriminant. */
export type AgentEventType = AgentEvent["type"];

// Re-export commonly needed LLM types for agent consumers (type-only).
export type {
	AssistantMessage,
	AssistantMessageEvent,
	ImageContent,
	Message,
	Model,
	StreamOptions,
	TextContent,
	ThinkingLevel,
	ToolCall,
	ToolResultMessage,
	Usage,
};
