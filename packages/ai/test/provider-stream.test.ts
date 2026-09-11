import { describe, expect, it } from "vitest";
import {
	createAnthropicMessagesModel,
	createOpenAICompletionsModel,
	createOpenAIResponsesModel,
} from "../src/index.ts";
import { createProviderStream, providerForApi } from "../src/provider-stream.ts";
import type { AssistantMessageEvent, Model } from "../src/types.ts";

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const e of stream) {
		events.push(e);
	}
	return events;
}

function captureFetch(urls: string[]): typeof fetch {
	return async (input, init) => {
		const req = new Request(input, init);
		urls.push(req.url);
		// Minimal terminating stream per api.
		let sse: string;
		if (req.url.endsWith("/responses")) {
			sse = `data: ${JSON.stringify({ type: "response.completed", response: { id: "r", status: "completed" } })}\n\n`;
		} else if (req.url.endsWith("/chat/completions")) {
			sse = `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
		} else {
			sse = `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } })}\n\nevent: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
		}
		return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
	};
}

describe("createProviderStream", () => {
	it("dispatches on model.api per call", async () => {
		const urls: string[] = [];
		const streamFn = createProviderStream({ fetch: captureFetch(urls) });
		const opts = { apiKey: "sk" };

		const responses = createOpenAIResponsesModel({ id: "m1", baseUrl: "https://a.test" });
		const completions = createOpenAICompletionsModel({ id: "m2", baseUrl: "https://b.test" });
		const anthropic = createAnthropicMessagesModel({ id: "m3", baseUrl: "https://c.test" });

		for (const m of [responses, completions, anthropic]) {
			const final = await (await streamFn(m, { messages: [] }, opts)).result();
			expect(final.stopReason).toBe("stop");
			expect(final.api).toBe(m.api);
		}
		expect(urls).toEqual([
			"https://a.test/responses",
			"https://b.test/chat/completions",
			"https://c.test/v1/messages",
		]);
	});

	it("encodes unknown api as an error result, not a throw", async () => {
		const streamFn = createProviderStream({ fetch: captureFetch([]) });
		const weird: Model = {
			id: "x",
			name: "x",
			api: "made-up-api",
			provider: "nobody",
			baseUrl: "https://x.test",
		};
		const events = await collect(await streamFn(weird, { messages: [] }, { apiKey: "sk" }));
		const final = await events.at(-1);
		expect(events.at(-1)?.type).toBe("error");
		expect(final?.type === "error" && final.error.stopReason === "error").toBe(true);
		expect(final?.type === "error" && final.error.errorMessage).toMatch(/made-up-api/);
	});
});

describe("providerForApi", () => {
	it("groups apis to provider names", () => {
		expect(providerForApi("anthropic-messages")).toBe("anthropic");
		expect(providerForApi("openai-responses")).toBe("openai");
		expect(providerForApi("openai-completions")).toBe("openai");
	});
});
