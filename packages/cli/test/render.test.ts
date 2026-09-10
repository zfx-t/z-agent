import { emptyUsage } from "@z-agent/ai";
import { describe, expect, it } from "vitest";
import { StreamRenderer } from "../src/render.ts";

describe("StreamRenderer", () => {
	it("writes text_delta live and does not reprint on message_end", () => {
		const bucket = { out: "" };
		const renderer = new StreamRenderer({
			stdout: {
				write: (chunk) => {
					bucket.out += chunk;
				},
			},
		});

		const partial = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Hel" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-4.1-mini",
			usage: emptyUsage(),
			stopReason: "stop" as const,
			timestamp: 1,
		};

		renderer.handle({
			type: "message_update",
			message: partial,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel", partial },
		});
		renderer.handle({
			type: "message_update",
			message: { ...partial, content: [{ type: "text", text: "Hello" }] },
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "lo",
				partial: { ...partial, content: [{ type: "text", text: "Hello" }] },
			},
		});
		renderer.handle({
			type: "message_end",
			message: { ...partial, content: [{ type: "text", text: "Hello" }] },
		});

		expect(bucket.out).toBe("Hello\n");
	});

	it("writes raw markdown text_delta bytes without rendering", () => {
		const bucket = { out: "" };
		const renderer = new StreamRenderer({
			stdout: {
				write: (chunk) => {
					bucket.out += chunk;
				},
			},
		});
		const source = "# Title\n\nHello **bold** and [docs](https://example.com)";
		const partial = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: source }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-4.1-mini",
			usage: emptyUsage(),
			stopReason: "stop" as const,
			timestamp: 1,
		};
		renderer.handle({
			type: "message_update",
			message: partial,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: source, partial },
		});
		renderer.handle({ type: "message_end", message: partial });
		expect(bucket.out).toBe(`${source}\n`);
		expect(bucket.out).toContain("**bold**");
		expect(bucket.out).toContain("[docs](https://example.com)");
	});

	it("prints compact tool start/end and hides lifecycle by default", () => {
		const bucket = { out: "" };
		const renderer = new StreamRenderer({
			stdout: {
				write: (chunk) => {
					bucket.out += chunk;
				},
			},
		});

		renderer.handle({ type: "agent_start" });
		renderer.handle({ type: "turn_start" });
		renderer.handle({
			type: "tool_execution_start",
			toolCallId: "1",
			toolName: "bash",
			args: { command: "ls" },
		});
		renderer.handle({
			type: "tool_execution_end",
			toolCallId: "1",
			toolName: "bash",
			isError: false,
			result: { content: [{ type: "text", text: "exit 0\nfile.txt" }], details: {} },
		});

		expect(bucket.out).toContain("[tool] bash ");
		expect(bucket.out).toContain("file.txt");
		expect(bucket.out).toContain("[tool_end] bash error=false");
		expect(bucket.out).not.toContain("agent_start");
	});

	it("dumps lifecycle when verbose", () => {
		const bucket = { out: "" };
		const renderer = new StreamRenderer({
			verbose: true,
			stdout: {
				write: (chunk) => {
					bucket.out += chunk;
				},
			},
		});
		renderer.handle({ type: "agent_start" });
		expect(bucket.out).toContain("[agent_start]");
	});
});
