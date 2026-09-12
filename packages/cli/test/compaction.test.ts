import type { AgentMessage } from "@z-agent/agent";
import { createAssistantMessageEventStream, type StreamFn } from "@z-agent/ai";
import { describe, expect, it } from "vitest";
import {
	applyCompactionToSession,
	type CompactionInfo,
	compactMessages,
	estimateTokens,
	hasOverflowStop,
	needsCompaction,
	shouldCompact,
} from "../src/compaction.ts";
import { createSession } from "../src/sessions.ts";

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function scriptedSummary(text: string): StreamFn {
	return () => {
		const stream = createAssistantMessageEventStream();
		const message = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text }],
			api: "test",
			provider: "test",
			model: "m",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: 1,
		};
		queueMicrotask(() => {
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: "stop", message });
			stream.end(message);
		});
		return stream;
	};
}

describe("compaction", () => {
	it("triggers when estimated tokens exceed window - reserve", () => {
		const huge = user("x".repeat(40_000));
		expect(shouldCompact([huge], { contextWindow: 8_000, reserveTokens: 1_000 })).toBe(true);
		expect(shouldCompact([user("hi")], { contextWindow: 8_000, reserveTokens: 1_000 })).toBe(false);
	});

	it("treats a missing or non-positive window as the default window", () => {
		expect(shouldCompact([user("hi")], { contextWindow: 0 })).toBe(false);
		expect(shouldCompact([user("hi")], { contextWindow: Number.NaN })).toBe(false);
	});

	it("triggers on assistant length overflow", () => {
		const assistant: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "cut" }],
			api: "t",
			provider: "t",
			model: "t",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "length",
			timestamp: 1,
		};
		expect(hasOverflowStop([user("hi"), assistant])).toBe(true);
		expect(needsCompaction([user("hi"), assistant], { contextWindow: 128_000 })).toBe(true);
	});

	it("keeps a recent tail and shortens the set", async () => {
		const messages = Array.from({ length: 20 }, (_, i) => user(`msg-${i}-${"y".repeat(200)}`));
		const { kept, summary } = await compactMessages(messages, { keepRecentTokens: 200 });
		expect(kept.length).toBeLessThan(messages.length);
		expect(estimateTokens(kept)).toBeLessThan(estimateTokens(messages));
		expect(summary).toContain("Compacted");
	});

	it("reports CompactionInfo through onCompaction", async () => {
		const messages = Array.from({ length: 20 }, (_, i) => user(`msg-${i}-${"y".repeat(200)}`));
		const infos: CompactionInfo[] = [];
		await applyCompactionToSession(createSession("/t"), messages, {
			keepRecentTokens: 200,
			onCompaction: (info) => infos.push(info),
		});
		expect(infos).toHaveLength(1);
		expect(infos[0]).toMatchObject({ reason: "threshold" });
		expect(infos[0]?.dropped).toBeGreaterThan(0);
		expect(infos[0]?.kept).toBeGreaterThan(0);
		expect(infos[0]?.estBefore).toBeGreaterThan(infos[0]?.estAfter ?? 0);
	});

	it("reports reason 'length' on overflow compaction", async () => {
		const assistant: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "cut" }],
			api: "t",
			provider: "t",
			model: "t",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "length",
			timestamp: 1,
		};
		const infos: CompactionInfo[] = [];
		await applyCompactionToSession(createSession("/t"), [user("hi"), assistant], {
			onCompaction: (info) => infos.push(info),
		});
		expect(infos[0]?.reason).toBe("length");
	});

	it("uses StreamFn for the dropped-message summary", async () => {
		const messages = Array.from({ length: 8 }, (_, i) => user(`msg-${i}-${"z".repeat(80)}`));
		const { summary } = await compactMessages(messages, {
			keepRecentTokens: 40,
			streamFn: scriptedSummary("LLM summary of old turns"),
			model: { id: "m", name: "m", api: "openai-responses", provider: "openai", baseUrl: "http://x" },
		});
		expect(summary).toBe("LLM summary of old turns");
	});
});
