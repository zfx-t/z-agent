/**
 * @z-agent/ai — LLM message protocol, stream events, StreamFn,
 * provider stream adapters (Responses / Completions / Anthropic Messages).
 */

export const AI_PACKAGE = "@z-agent/ai" as const;

export type { AnthropicMessagesConfig, AnthropicMessagesStreamOptions } from "./anthropic-messages.ts";
export {
	buildAnthropicBody,
	convertAnthropicMessages,
	convertAnthropicTools,
	createAnthropicMessagesModel,
	createAnthropicMessagesStream,
	streamAnthropicMessages,
} from "./anthropic-messages.ts";
export type { AssistantMessageEventStream } from "./event-stream.ts";
export { createAssistantMessageEventStream, EventStream } from "./event-stream.ts";
export type { OpenAICompletionsConfig, OpenAICompletionsStreamOptions } from "./openai-completions.ts";
export {
	buildCompletionsBody,
	convertCompletionsMessages,
	convertCompletionsTools,
	createOpenAICompletionsModel,
	createOpenAICompletionsStream,
	streamOpenAICompletions,
} from "./openai-completions.ts";
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
export type { ProviderApi, ProviderStreamConfig } from "./provider-stream.ts";
export { createProviderStream, PROVIDER_APIS, providerForApi } from "./provider-stream.ts";
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
