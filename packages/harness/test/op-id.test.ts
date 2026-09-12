import type { Context } from "@z-agent/ai";
import { describe, expect, it } from "vitest";
import { canonicalJson, intentHash, sha256Hex, streamOpId, toolOpId } from "../src/op-id.ts";

function contextWith(messages: unknown[], extras: Partial<Context> = {}): Context {
	return { messages: messages as Context["messages"], ...extras };
}

const userMsg = (text: string) => ({ role: "user", content: text, timestamp: 1 });

describe("canonicalJson", () => {
	it("sorts keys recursively", () => {
		expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
	});

	it("drops undefined fields and keeps array order", () => {
		expect(canonicalJson({ a: undefined, b: [3, 1, 2] })).toBe('{"b":[3,1,2]}');
	});

	it("is stable across insertion order", () => {
		const left = canonicalJson({ x: { y: 1, z: 2 }, a: "s" });
		const right = canonicalJson({ a: "s", x: { z: 2, y: 1 } });
		expect(left).toBe(right);
	});
});

describe("streamOpId", () => {
	const base = { modelId: "m1", api: "openai-responses" };

	it("differs for equal-length contexts with different text", () => {
		const a = streamOpId({ ...base, sessionId: "s", context: contextWith([userMsg("hello")]) });
		const b = streamOpId({ ...base, sessionId: "s", context: contextWith([userMsg("world")]) });
		expect(a.opId).not.toBe(b.opId);
		expect(a.contextHash).not.toBe(b.contextHash);
	});

	it("is stable for the same context built with different key order", () => {
		const msgA = { role: "user", content: "hi", timestamp: 1 };
		const msgB = { timestamp: 1, content: "hi", role: "user" };
		const a = streamOpId({ ...base, sessionId: "s", context: contextWith([msgA]) });
		const b = streamOpId({ ...base, sessionId: "s", context: contextWith([msgB]) });
		expect(a.opId).toBe(b.opId);
	});

	it("changes when systemPrompt or tools change", () => {
		const plain = streamOpId({ ...base, context: contextWith([userMsg("hi")]) });
		const withPrompt = streamOpId({
			...base,
			context: contextWith([userMsg("hi")], { systemPrompt: "be brief" }),
		});
		const withTools = streamOpId({
			...base,
			context: contextWith([userMsg("hi")], {
				tools: [{ name: "t", description: "d", parameters: { type: "object" } }],
			}),
		});
		expect(plain.opId).not.toBe(withPrompt.opId);
		expect(plain.opId).not.toBe(withTools.opId);
	});

	it("uses anon when sessionId is absent and has the expected shape", () => {
		const { opId } = streamOpId({ ...base, context: contextWith([userMsg("hi")]) });
		expect(opId).toMatch(/^stream:anon:[0-9a-f]{32}$/);
		const scoped = streamOpId({ ...base, sessionId: "sess-1", context: contextWith([userMsg("hi")]) });
		expect(scoped.opId).toMatch(/^stream:sess-1:[0-9a-f]{32}$/);
	});

	it("hashes a 5 MB image block quickly", () => {
		const data = "a".repeat(5 * 1024 * 1024);
		const image = { role: "user", content: [{ type: "image", data, mimeType: "image/png" }], timestamp: 1 };
		const start = performance.now();
		streamOpId({ ...base, context: contextWith([image]) });
		expect(performance.now() - start).toBeLessThan(500);
	});
});

describe("toolOpId / intentHash / sha256Hex", () => {
	it("toolOpId prefixes the call id", () => {
		expect(toolOpId("call_1")).toBe("tool:call_1");
	});

	it("intentHash is order-independent", () => {
		expect(intentHash({ name: "write", params: { b: 1, a: 2 } })).toBe(
			intentHash({ params: { a: 2, b: 1 }, name: "write" }),
		);
	});

	it("sha256Hex accepts strings and bytes", () => {
		expect(sha256Hex("abc")).toMatch(/^[0-9a-f]{64}$/);
		expect(sha256Hex(new Uint8Array([1, 2, 3]))).toMatch(/^[0-9a-f]{64}$/);
	});
});
