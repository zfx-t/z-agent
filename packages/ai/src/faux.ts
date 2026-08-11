import type { AssistantMessageEventStream } from "./event-stream.ts";
import { createAssistantMessageEventStream } from "./event-stream.ts";
import type {
	AssistantMessage,
	Context,
	Model,
	StreamFn,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "./types.ts";
import { emptyUsage } from "./types.ts";

const DEFAULT_API = "faux";
const DEFAULT_PROVIDER = "faux";
const DEFAULT_MODEL_ID = "faux-1";
const DEFAULT_MODEL_NAME = "Faux Model";
const DEFAULT_BASE_URL = "http://localhost:0";
/** Default: emit each block in a single delta (deterministic tests). */
const DEFAULT_CHUNK_CHARS = 0;

// ---------------------------------------------------------------------------
// Content helpers
// ---------------------------------------------------------------------------

export type FauxContentBlock = TextContent | ThinkingContent | ToolCall;

export function fauxText(text: string): TextContent {
	return { type: "text", text };
}

export function fauxThinking(thinking: string): ThinkingContent {
	return { type: "thinking", thinking };
}

export function fauxToolCall(name: string, args: ToolCall["arguments"], options: { id?: string } = {}): ToolCall {
	return {
		type: "toolCall",
		id: options.id ?? randomId("tool"),
		name,
		arguments: args,
	};
}

function normalizeContent(content: string | FauxContentBlock | FauxContentBlock[]): FauxContentBlock[] {
	if (typeof content === "string") {
		return [fauxText(content)];
	}
	return Array.isArray(content) ? content : [content];
}

export function fauxAssistantMessage(
	content: string | FauxContentBlock | FauxContentBlock[],
	options: {
		stopReason?: AssistantMessage["stopReason"];
		errorMessage?: string;
		responseId?: string;
		timestamp?: number;
		api?: string;
		provider?: string;
		model?: string;
	} = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: normalizeContent(content),
		api: options.api ?? DEFAULT_API,
		provider: options.provider ?? DEFAULT_PROVIDER,
		model: options.model ?? DEFAULT_MODEL_ID,
		usage: emptyUsage(),
		stopReason: options.stopReason ?? "stop",
		errorMessage: options.errorMessage,
		responseId: options.responseId,
		timestamp: options.timestamp ?? Date.now(),
	};
}

// ---------------------------------------------------------------------------
// Faux provider handle
// ---------------------------------------------------------------------------

export interface FauxProviderState {
	callCount: number;
}

export type FauxResponseFactory = (
	context: Context,
	options: StreamOptions | undefined,
	state: FauxProviderState,
	model: Model,
) => AssistantMessage | Promise<AssistantMessage>;

export type FauxResponseStep = AssistantMessage | FauxResponseFactory;

export interface CreateFauxStreamOptions {
	api?: string;
	provider?: string;
	model?: Partial<Pick<Model, "id" | "name" | "baseUrl" | "reasoning" | "input" | "contextWindow" | "maxTokens">>;
	/** Initial response queue. */
	responses?: FauxResponseStep[];
	/**
	 * Max characters per text/thinking/toolcall delta.
	 * `0` (default) = one delta per content block (fully deterministic).
	 */
	chunkChars?: number;
}

export interface FauxStreamHandle {
	/** Injected StreamFn — never throws for empty queue / scripted errors. */
	streamFn: StreamFn;
	model: Model;
	state: FauxProviderState;
	setResponses: (responses: FauxResponseStep[]) => void;
	appendResponses: (responses: FauxResponseStep[]) => void;
	getPendingResponseCount: () => number;
}

function randomId(prefix: string): string {
	return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}

function splitChunks(text: string, chunkChars: number): string[] {
	if (chunkChars <= 0 || text.length === 0) {
		return [text];
	}
	const chunks: string[] = [];
	for (let i = 0; i < text.length; i += chunkChars) {
		chunks.push(text.slice(i, i + chunkChars));
	}
	return chunks.length > 0 ? chunks : [""];
}

/** Yield so AbortSignal and consumers can interleave with scripted deltas. */
function yieldTick(): Promise<void> {
	return new Promise((resolve) => queueMicrotask(resolve));
}

/** Snapshot of the live partial for event payloads (deep-clone content blocks). */
function snapshotPartial(partial: AssistantMessage): AssistantMessage {
	return {
		...partial,
		content: partial.content.map((block) => structuredClone(block)),
	};
}

function createErrorMessage(error: unknown, model: Model): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

function createAbortedMessage(partial: AssistantMessage): AssistantMessage {
	return {
		...snapshotPartial(partial),
		stopReason: "aborted",
		errorMessage: partial.errorMessage ?? "Request was aborted",
		timestamp: Date.now(),
	};
}

/**
 * Stream a scripted assistant message as start → content partials → done/error.
 *
 * Mutates a single `partial` (including `partial.content`) so abort terminal
 * messages retain all streamed blocks — matching agent-loop / pi semantics.
 *
 * Tool-call JSON fragments are emitted on `toolcall_delta`; `arguments` on the
 * partial stay `{}` until `toolcall_end` (final args only guaranteed then).
 */
async function streamScriptedMessage(
	stream: AssistantMessageEventStream,
	message: AssistantMessage,
	chunkChars: number,
	signal: AbortSignal | undefined,
): Promise<void> {
	// Single live partial: content array is mutated in place (pi style).
	const partial: AssistantMessage = {
		...message,
		content: [],
		stopReason: "pending",
	};

	const pushAbort = (): boolean => {
		if (!signal?.aborted) return false;
		const aborted = createAbortedMessage(partial);
		stream.push({ type: "error", reason: "aborted", error: aborted });
		stream.end(aborted);
		return true;
	};

	if (pushAbort()) return;

	stream.push({ type: "start", partial: snapshotPartial(partial) });

	for (let index = 0; index < message.content.length; index++) {
		if (pushAbort()) return;

		const block = message.content[index];
		if (!block) continue;

		if (block.type === "thinking") {
			const thinkingBlock: ThinkingContent = { type: "thinking", thinking: "" };
			partial.content.push(thinkingBlock);
			stream.push({
				type: "thinking_start",
				contentIndex: index,
				partial: snapshotPartial(partial),
			});
			for (const chunk of splitChunks(block.thinking, chunkChars)) {
				await yieldTick();
				if (pushAbort()) return;
				thinkingBlock.thinking += chunk;
				stream.push({
					type: "thinking_delta",
					contentIndex: index,
					delta: chunk,
					partial: snapshotPartial(partial),
				});
			}
			if (pushAbort()) return;
			thinkingBlock.thinking = block.thinking;
			if (block.thinkingSignature !== undefined) {
				thinkingBlock.thinkingSignature = block.thinkingSignature;
			}
			if (block.redacted !== undefined) {
				thinkingBlock.redacted = block.redacted;
			}
			stream.push({
				type: "thinking_end",
				contentIndex: index,
				content: block.thinking,
				partial: snapshotPartial(partial),
			});
			continue;
		}

		if (block.type === "text") {
			const textBlock: TextContent = { type: "text", text: "" };
			partial.content.push(textBlock);
			stream.push({
				type: "text_start",
				contentIndex: index,
				partial: snapshotPartial(partial),
			});
			for (const chunk of splitChunks(block.text, chunkChars)) {
				await yieldTick();
				if (pushAbort()) return;
				textBlock.text += chunk;
				stream.push({
					type: "text_delta",
					contentIndex: index,
					delta: chunk,
					partial: snapshotPartial(partial),
				});
			}
			if (pushAbort()) return;
			textBlock.text = block.text;
			if (block.textSignature !== undefined) {
				textBlock.textSignature = block.textSignature;
			}
			stream.push({
				type: "text_end",
				contentIndex: index,
				content: block.text,
				partial: snapshotPartial(partial),
			});
			continue;
		}

		// toolCall — arguments stay {} until toolcall_end (see AssistantMessageEvent docs).
		const toolBlock: ToolCall = {
			type: "toolCall",
			id: block.id,
			name: block.name,
			arguments: {},
		};
		partial.content.push(toolBlock);
		stream.push({
			type: "toolcall_start",
			contentIndex: index,
			partial: snapshotPartial(partial),
		});
		const argsJson = JSON.stringify(block.arguments);
		for (const chunk of splitChunks(argsJson, chunkChars)) {
			await yieldTick();
			if (pushAbort()) return;
			stream.push({
				type: "toolcall_delta",
				contentIndex: index,
				delta: chunk,
				partial: snapshotPartial(partial),
			});
		}
		if (pushAbort()) return;
		toolBlock.arguments = block.arguments;
		if (block.thoughtSignature !== undefined) {
			toolBlock.thoughtSignature = block.thoughtSignature;
		}
		if (block.namespace !== undefined) {
			toolBlock.namespace = block.namespace;
		}
		stream.push({
			type: "toolcall_end",
			contentIndex: index,
			toolCall: structuredClone(block),
			partial: snapshotPartial(partial),
		});
	}

	// Abort after last content block, before terminal done/error.
	if (pushAbort()) return;

	if (message.stopReason === "pending") {
		const err = createErrorMessage(new Error("Faux response ended without a stop reason"), {
			id: message.model,
			name: message.model,
			api: message.api,
			provider: message.provider,
			baseUrl: DEFAULT_BASE_URL,
		});
		stream.push({ type: "error", reason: "error", error: err });
		stream.end(err);
		return;
	}

	if (message.stopReason === "error" || message.stopReason === "aborted") {
		const finalMessage: AssistantMessage = {
			...message,
			content: partial.content.map((b) => structuredClone(b)),
		};
		stream.push({ type: "error", reason: message.stopReason, error: finalMessage });
		stream.end(finalMessage);
		return;
	}

	const finalMessage: AssistantMessage = {
		...message,
		content: partial.content.map((b) => structuredClone(b)),
	};
	stream.push({
		type: "done",
		reason: message.stopReason,
		message: finalMessage,
	});
	stream.end(finalMessage);
}

/**
 * Create a scripted in-process StreamFn for tests.
 *
 * - Responses are drained FIFO via {@link FauxStreamHandle.setResponses}.
 * - Empty queue yields an error assistant message (does not throw).
 * - Factories receive context / options / state / model for dynamic scripts.
 */
export function createFauxStream(options: CreateFauxStreamOptions = {}): FauxStreamHandle {
	const api = options.api ?? DEFAULT_API;
	const provider = options.provider ?? DEFAULT_PROVIDER;
	const chunkChars = options.chunkChars ?? DEFAULT_CHUNK_CHARS;

	const model: Model = {
		id: options.model?.id ?? DEFAULT_MODEL_ID,
		name: options.model?.name ?? DEFAULT_MODEL_NAME,
		api,
		provider,
		baseUrl: options.model?.baseUrl ?? DEFAULT_BASE_URL,
		reasoning: options.model?.reasoning,
		input: options.model?.input ?? ["text"],
		contextWindow: options.model?.contextWindow,
		maxTokens: options.model?.maxTokens,
	};

	let pending: FauxResponseStep[] = options.responses ? [...options.responses] : [];
	const state: FauxProviderState = { callCount: 0 };

	const streamFn: StreamFn = (streamModel, context, streamOptions) => {
		const stream = createAssistantMessageEventStream();

		// Fire-and-forget async body so StreamFn itself never throws.
		void (async () => {
			try {
				state.callCount += 1;
				const step = pending.shift();
				if (!step) {
					const err = createErrorMessage(new Error("No more faux responses queued"), streamModel);
					stream.push({ type: "error", reason: "error", error: err });
					stream.end(err);
					return;
				}

				const resolved = typeof step === "function" ? await step(context, streamOptions, state, streamModel) : step;

				const message: AssistantMessage = {
					...structuredClone(resolved),
					api: streamModel.api,
					provider: streamModel.provider,
					model: streamModel.id,
					timestamp: resolved.timestamp ?? Date.now(),
					usage: resolved.usage ?? emptyUsage(),
				};

				await streamScriptedMessage(stream, message, chunkChars, streamOptions?.signal);
			} catch (error) {
				const err = createErrorMessage(error, streamModel);
				stream.push({ type: "error", reason: "error", error: err });
				stream.end(err);
			}
		})();

		return stream;
	};

	return {
		streamFn,
		model,
		state,
		setResponses(responses: FauxResponseStep[]) {
			pending = [...responses];
		},
		appendResponses(responses: FauxResponseStep[]) {
			pending.push(...responses);
		},
		getPendingResponseCount() {
			return pending.length;
		},
	};
}

/** Alias matching the design-doc name. */
export const createFauxProvider = createFauxStream;
