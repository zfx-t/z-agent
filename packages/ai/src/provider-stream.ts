/**
 * Provider dispatch (ADR-0027): one StreamFn that routes each call on
 * `model.api` to the matching adapter.
 *
 * Dispatch happens per invocation — switching `model.api` mid-session
 * (e.g. `/model` to a different alias) takes effect on the next request.
 */

import { streamAnthropicMessages } from "./anthropic-messages.ts";
import type { AssistantMessageEventStream } from "./event-stream.ts";
import { createAssistantMessageEventStream } from "./event-stream.ts";
import { streamOpenAICompletions } from "./openai-completions.ts";
import { streamOpenAIResponses } from "./openai-responses.ts";
import { createPendingOutput, type ProviderHttpConfig } from "./provider-shared.ts";
import type { Context, Model, StreamFn, StreamOptions } from "./types.ts";

export type ProviderApi = "openai-responses" | "openai-completions" | "anthropic-messages";

export const PROVIDER_APIS: readonly ProviderApi[] = ["openai-responses", "openai-completions", "anthropic-messages"];

/** Display/provider grouping for an api id. */
export function providerForApi(api: string): string {
	switch (api) {
		case "anthropic-messages":
			return "anthropic";
		default:
			return "openai";
	}
}

export interface ProviderStreamConfig extends ProviderHttpConfig {}

function streamUnsupportedApi(model: Model): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const output = createPendingOutput(model);
	output.stopReason = "error";
	output.errorMessage = `Unknown model api: ${model.api}`;
	stream.push({ type: "start", partial: output });
	stream.push({ type: "error", reason: "error", error: output });
	stream.end(output);
	return stream;
}

/**
 * Returns a StreamFn that dispatches on `model.api` per call:
 * `openai-responses` | `openai-completions` | `anthropic-messages`.
 * Unknown apis yield an error-encoded AssistantMessage instead of throwing.
 */
export function createProviderStream(config: ProviderStreamConfig = {}): StreamFn {
	return (model: Model, context: Context, options?: StreamOptions) => {
		switch (model.api) {
			case "openai-responses":
				return streamOpenAIResponses(model, context, options, config);
			case "openai-completions":
				return streamOpenAICompletions(model, context, options, config);
			case "anthropic-messages":
				return streamAnthropicMessages(model, context, options, config);
			default:
				return streamUnsupportedApi(model);
		}
	};
}
