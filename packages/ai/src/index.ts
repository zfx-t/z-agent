/**
 * @z-agent/ai — LLM message protocol, stream events, StreamFn,
 * OpenAI Responses API production stream (ADR-0005).
 */

export const AI_PACKAGE = "@z-agent/ai" as const;

export type { AssistantMessageEventStream } from "./event-stream.ts";
export { createAssistantMessageEventStream, EventStream } from "./event-stream.ts";
export type { OpenAIResponsesConfig, OpenAIResponsesStreamOptions } from "./openai-responses.ts";
export {
	buildResponsesBody,
	convertResponsesMessages,
	convertResponsesTools,
	createOpenAIResponsesModel,
	createOpenAIResponsesStream,
	parseResponsesSse,
	streamOpenAIResponses,
} from "./openai-responses.ts";
export type {
	AssistantContent,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	ImageContent,
	Message,
	Model,
	StopReason,
	StreamFn,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ThinkingLevel,
	Tool,
	ToolCall,
	ToolResultContent,
	ToolResultMessage,
	Usage,
	UsageCost,
	UserContent,
	UserMessage,
} from "./types.ts";
export { emptyUsage } from "./types.ts";
