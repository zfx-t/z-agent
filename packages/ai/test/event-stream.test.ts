import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, EventStream } from "../src/event-stream.ts";
import type { AssistantMessage } from "../src/types.ts";
import { emptyUsage } from "../src/types.ts";

function assistant(partial: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "hi" }],
		api: "test",
		provider: "test",
		model: "m",
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: 0,
		...partial,
	};
}

describe("EventStream", () => {
	it("delivers queued events to async consumers", async () => {
		const stream = new EventStream<number, number>(
			(n) => n < 0,
			(n) => n,
		);
		stream.push(1);
		stream.push(2);
		stream.push(-1);
		stream.end();

		const seen: number[] = [];
		for await (const n of stream) {
			seen.push(n);
		}
		expect(seen).toEqual([1, 2, -1]);
		await expect(stream.result()).resolves.toBe(-1);
	});

	it("wakes a waiting consumer on push", async () => {
		const stream = new EventStream<string, string>(
			(s) => s === "done",
			(s) => s,
		);

		const consumer = (async () => {
			const out: string[] = [];
			for await (const e of stream) {
				out.push(e);
			}
			return out;
		})();

		// Let the consumer park on the waiter.
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		stream.push("a");
		stream.push("done");
		stream.end();

		await expect(consumer).resolves.toEqual(["a", "done"]);
		await expect(stream.result()).resolves.toBe("done");
	});

	it("end(result) without a completing push resolves result()", async () => {
		const stream = new EventStream<string, string>(
			() => false,
			() => {
				throw new Error("should not extract from non-completing events");
			},
		);
		stream.push("partial");
		stream.end("fallback");

		const seen: string[] = [];
		for await (const e of stream) {
			seen.push(e);
		}
		expect(seen).toEqual(["partial"]);
		await expect(stream.result()).resolves.toBe("fallback");
	});

	it("bare end() without result rejects result()", async () => {
		const stream = new EventStream<string, string>(
			() => false,
			() => "unused",
		);
		stream.push("x");
		stream.end();

		await expect(stream.result()).rejects.toThrow("EventStream ended without a final result");
	});
});

describe("AssistantMessageEventStream", () => {
	it("resolves result from done event", async () => {
		const stream = createAssistantMessageEventStream();
		const message = assistant();
		const partial = assistant({ stopReason: "pending", content: [] });

		stream.push({ type: "start", partial });
		stream.push({ type: "done", reason: "stop", message });
		stream.end();

		const events = [];
		for await (const e of stream) {
			events.push(e.type);
		}
		expect(events).toEqual(["start", "done"]);
		await expect(stream.result()).resolves.toEqual(message);
	});

	it("resolves result from error event", async () => {
		const stream = createAssistantMessageEventStream();
		const error = assistant({ stopReason: "error", errorMessage: "boom", content: [] });
		stream.push({ type: "error", reason: "error", error });
		stream.end();

		await expect(stream.result()).resolves.toMatchObject({
			stopReason: "error",
			errorMessage: "boom",
		});
	});

	it("end(message) without done/error still resolves result()", async () => {
		const stream = createAssistantMessageEventStream();
		const message = assistant({ content: [], stopReason: "aborted", errorMessage: "manual end" });
		stream.push({ type: "start", partial: assistant({ stopReason: "pending", content: [] }) });
		stream.end(message);

		await expect(stream.result()).resolves.toEqual(message);
	});
});
