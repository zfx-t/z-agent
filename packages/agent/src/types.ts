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
 * Defaults (when shell/queues land): steering and follow-up use `"one-at-a-time"`.
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
 * {@link import("@z-agent/ai").Tool} at the LLM boundary is done by the loop later.
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
 * toolExecution defaults to `"parallel"` (three-phase). Queue drains land in later PRs.
 */
export interface AgentLoopConfig {
	/** Model used for the next provider request. */
	model: Model;

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
	ToolCall,
	ToolResultMessage,
	Usage,
};
