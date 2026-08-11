import { describe, expect, it } from "vitest";
import { createFauxStream, fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "../src/faux.ts";
import type { AssistantMessageEvent } from "../src/types.ts";

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const e of stream) {
		events.push(e);
	}
	return events;
}

describe("createFauxStream", () => {
	it("exports a working StreamFn for a text turn", async () => {
		const faux = createFauxStream({
			responses: [fauxAssistantMessage("hello world")],
		});

		const stream = await faux.streamFn(faux.model, { messages: [] });
		const events = await collect(stream);
		const message = await stream.result();

		expect(faux.state.callCount).toBe(1);
		expect(events[0]?.type).toBe("start");
		expect(events.some((e) => e.type === "text_start")).toBe(true);
		expect(events.some((e) => e.type === "text_delta")).toBe(true);
		expect(events.some((e) => e.type === "text_end")).toBe(true);
		expect(events.at(-1)?.type).toBe("done");
		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([{ type: "text", text: "hello world" }]);
		expect(message.model).toBe(faux.model.id);
		expect(message.provider).toBe(faux.model.provider);
	});

	it("streams thinking + toolCall + text", async () => {
		const faux = createFauxStream({
			responses: [
				fauxAssistantMessage(
					[fauxThinking("plan"), fauxToolCall("echo", { text: "hi" }, { id: "t1" }), fauxText("done")],
					{ stopReason: "toolUse" },
				),
			],
		});

		const stream = await faux.streamFn(faux.model, { messages: [] });
		const events = await collect(stream);
		const message = await stream.result();

		const types = events.map((e) => e.type);
		expect(types).toContain("thinking_start");
		expect(types).toContain("thinking_end");
		expect(types).toContain("toolcall_start");
		expect(types).toContain("toolcall_end");
		expect(types).toContain("text_start");
		expect(types).toContain("text_end");
		expect(types.at(-1)).toBe("done");
		expect(message.stopReason).toBe("toolUse");
		expect(message.content).toEqual([
			{ type: "thinking", thinking: "plan" },
			{ type: "toolCall", id: "t1", name: "echo", arguments: { text: "hi" } },
			{ type: "text", text: "done" },
		]);
	});

	it("encodes empty queue as error message (does not throw)", async () => {
		const faux = createFauxStream();
		const stream = await faux.streamFn(faux.model, { messages: [] });
		const events = await collect(stream);
		const message = await stream.result();

		expect(events.at(-1)?.type).toBe("error");
		expect(events.length).toBeGreaterThan(0);
		// Iterator completed (collect returned).
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe("No more faux responses queued");
	});

	it("emits done with reason length for stopReason length", async () => {
		const faux = createFauxStream({
			responses: [fauxAssistantMessage("truncated", { stopReason: "length" })],
		});
		const stream = await faux.streamFn(faux.model, { messages: [] });
		const events = await collect(stream);
		const message = await stream.result();

		const terminal = events.at(-1);
		expect(terminal?.type).toBe("done");
		if (terminal?.type === "done") {
			expect(terminal.reason).toBe("length");
		}
		expect(message.stopReason).toBe("length");
		expect(message.content).toEqual([{ type: "text", text: "truncated" }]);
	});

	it("drains responses FIFO and supports set/append", async () => {
		const faux = createFauxStream({
			responses: [fauxAssistantMessage("first")],
		});
		faux.appendResponses([fauxAssistantMessage("second")]);
		expect(faux.getPendingResponseCount()).toBe(2);

		const first = await (await faux.streamFn(faux.model, { messages: [] })).result();
		expect(first.content).toEqual([{ type: "text", text: "first" }]);

		faux.setResponses([fauxAssistantMessage("third")]);
		const third = await (await faux.streamFn(faux.model, { messages: [] })).result();
		expect(third.content).toEqual([{ type: "text", text: "third" }]);
		expect(faux.getPendingResponseCount()).toBe(0);
	});

	it("supports factory responses with context", async () => {
		const faux = createFauxStream({
			responses: [
				(context, _opts, state) => fauxAssistantMessage(`n=${context.messages.length}:call=${state.callCount}`),
			],
		});

		const message = await (
			await faux.streamFn(faux.model, {
				messages: [
					{ role: "user", content: "hi", timestamp: 0 },
					{ role: "user", content: "again", timestamp: 1 },
				],
			})
		).result();

		expect(message.content).toEqual([{ type: "text", text: "n=2:call=1" }]);
	});

	it("respects AbortSignal mid-stream and retains partial content", async () => {
		const controller = new AbortController();
		const faux = createFauxStream({
			chunkChars: 1,
			responses: [fauxAssistantMessage("abcdefghij")],
		});

		const stream = await faux.streamFn(faux.model, { messages: [] }, { signal: controller.signal });

		const types: string[] = [];
		let lastPartialContent: unknown;
		let aborted = false;
		for await (const e of stream) {
			types.push(e.type);
			if ("partial" in e) {
				lastPartialContent = e.partial.content;
			}
			// Abort after the first delta so remaining chunks see the signal.
			if (e.type === "text_delta" && !aborted) {
				aborted = true;
				controller.abort();
			}
		}
		const message = await stream.result();

		expect(types[0]).toBe("start");
		expect(types.at(-1)).toBe("error");
		expect(message.stopReason).toBe("aborted");
		// Regression: abort must not wipe content already observed on partials.
		expect(message.content.length).toBeGreaterThan(0);
		expect(message.content[0]).toMatchObject({ type: "text" });
		if (message.content[0]?.type === "text") {
			expect(message.content[0].text.length).toBeGreaterThan(0);
		}
		expect(lastPartialContent).toEqual(message.content);
	});

	it("respects already-aborted signal", async () => {
		const controller = new AbortController();
		controller.abort();
		const faux = createFauxStream({
			responses: [fauxAssistantMessage("never")],
		});

		const stream = await faux.streamFn(faux.model, { messages: [] }, { signal: controller.signal });
		const message = await stream.result();
		expect(message.stopReason).toBe("aborted");
	});

	it("emits error event for scripted error stopReason", async () => {
		const faux = createFauxStream({
			responses: [fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider failed" })],
		});
		const stream = await faux.streamFn(faux.model, { messages: [] });
		const events = await collect(stream);
		const message = await stream.result();

		expect(events.at(-1)?.type).toBe("error");
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe("provider failed");
	});

	it("splits deltas when chunkChars is set", async () => {
		const faux = createFauxStream({
			chunkChars: 3,
			responses: [fauxAssistantMessage("abcdef")],
		});
		const stream = await faux.streamFn(faux.model, { messages: [] });
		const events = await collect(stream);
		const deltas = events.filter((e) => e.type === "text_delta");
		expect(deltas.map((e) => (e.type === "text_delta" ? e.delta : ""))).toEqual(["abc", "def"]);
	});
});
