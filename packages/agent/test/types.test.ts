import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import type {
	AgentContext,
	AgentEvent,
	AgentMessage,
	AgentTool,
	AgentToolResult,
	CustomAgentMessages,
	QueueMode,
	ToolExecutionMode,
	ToolResultMessage,
} from "../src/index.ts";
import { AGENT_PACKAGE } from "../src/index.ts";

describe("agent type surface", () => {
	it("exports package identity", () => {
		expect(AGENT_PACKAGE).toBe("@z-agent/agent");
	});

	it("AgentMessage accepts LLM user messages", () => {
		const msg: AgentMessage = {
			role: "user",
			content: "hello",
			timestamp: 1,
		};
		expect(msg.role).toBe("user");
	});

	it("AgentMessage accepts assistant and toolResult shapes", () => {
		const assistant: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
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
			stopReason: "stop",
			timestamp: 2,
		};
		const toolResult: AgentMessage = {
			role: "toolResult",
			toolCallId: "t1",
			toolName: "echo",
			content: [{ type: "text", text: "x" }],
			isError: false,
			timestamp: 3,
		};
		expect(assistant.role).toBe("assistant");
		expect(toolResult.role).toBe("toolResult");
	});

	it("modes are closed string unions", () => {
		const q: QueueMode = "one-at-a-time";
		const t: ToolExecutionMode = "parallel";
		expect(q).toBe("one-at-a-time");
		expect(t).toBe("parallel");
		expectTypeOf<QueueMode>().toEqualTypeOf<"all" | "one-at-a-time">();
		expectTypeOf<ToolExecutionMode>().toEqualTypeOf<"sequential" | "parallel">();
	});

	it("AgentTool uses zod parameters and infers execute params", async () => {
		const schema = z.object({ n: z.number() });
		const tool: AgentTool<typeof schema, { doubled: number }> = {
			name: "double",
			label: "Double",
			description: "double a number",
			parameters: schema,
			async execute(_id, params) {
				expectTypeOf(params).toEqualTypeOf<{ n: number }>();
				const result: AgentToolResult<{ doubled: number }> = {
					content: [{ type: "text", text: String(params.n * 2) }],
					details: { doubled: params.n * 2 },
				};
				return result;
			},
		};
		const out = await tool.execute("id", { n: 21 });
		expect(out.details.doubled).toBe(42);
		expect(tool.parameters.parse({ n: 1 })).toEqual({ n: 1 });
	});

	it("default AgentTool execute params are unknown (not any)", () => {
		type DefaultParams = Parameters<AgentTool["execute"]>[1];
		expectTypeOf<DefaultParams>().toEqualTypeOf<unknown>();
		// IsAny guard: any would match both branches of this conditional
		type IsAny<T> = 0 extends 1 & T ? true : false;
		expectTypeOf<IsAny<DefaultParams>>().toEqualTypeOf<false>();
	});

	it("concrete AgentTool is assignable to AgentTool[] and AgentContext.tools", async () => {
		const schema = z.object({ n: z.number() });
		const typed: AgentTool<typeof schema, { doubled: number }> = {
			name: "double",
			label: "Double",
			description: "double a number",
			parameters: schema,
			prepareArguments(args) {
				return schema.parse(args);
			},
			async execute(_id, params) {
				return {
					content: [{ type: "text", text: String(params.n * 2) }],
					details: { doubled: params.n * 2 },
				};
			},
		};

		// Regression: method bivariance must allow concrete tools in the bag.
		const tools: AgentTool[] = [typed];
		const ctx: AgentContext = {
			systemPrompt: "sys",
			messages: [],
			tools: [typed],
		};

		expect(tools).toHaveLength(1);
		expect(ctx.tools).toHaveLength(1);
		const out = await tools[0]!.execute("id", { n: 3 });
		expect(out.content[0]).toEqual({ type: "text", text: "6" });
	});

	it("tool_execution events carry AgentToolResult payloads", () => {
		const result: AgentToolResult = {
			content: [{ type: "text", text: "ok" }],
			details: undefined,
		};
		const update: AgentEvent = {
			type: "tool_execution_update",
			toolCallId: "c1",
			toolName: "t",
			args: {},
			partialResult: result,
		};
		const end: AgentEvent = {
			type: "tool_execution_end",
			toolCallId: "c1",
			toolName: "t",
			result,
			isError: false,
		};
		expect(update.type).toBe("tool_execution_update");
		expect(end.type).toBe("tool_execution_end");
	});

	it("ToolResultMessage accepts optional usage (dual-layer seam)", () => {
		const msg: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "c1",
			toolName: "echo",
			content: [{ type: "text", text: "x" }],
			isError: false,
			timestamp: 0,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		expect(msg.usage?.totalTokens).toBe(0);
	});

	it("ToolResultMessage accepts optional addedToolNames", () => {
		const msg: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "c1",
			toolName: "echo",
			content: [{ type: "text", text: "x" }],
			isError: false,
			timestamp: 0,
			addedToolNames: ["search"],
		};
		expect(msg.addedToolNames).toEqual(["search"]);
	});

	it("AgentContext holds AgentMessage transcript and tools", () => {
		const ctx: AgentContext = {
			systemPrompt: "sys",
			messages: [{ role: "user", content: "hi", timestamp: 0 }],
			tools: [],
		};
		expect(ctx.messages).toHaveLength(1);
	});

	it("AgentEvent discriminants cover oracle lifecycle names", () => {
		const names: AgentEvent["type"][] = [
			"agent_start",
			"agent_end",
			"turn_start",
			"turn_end",
			"message_start",
			"message_update",
			"message_end",
			"tool_execution_start",
			"tool_execution_update",
			"tool_execution_end",
		];
		expect(new Set(names).size).toBe(10);
	});

	it("CustomAgentMessages is empty by default (declaration merge surface)", () => {
		// keyof empty interface is never — union with Message alone.
		type Keys = keyof CustomAgentMessages;
		expectTypeOf<Keys>().toEqualTypeOf<never>();
		expectTypeOf<AgentMessage>().toMatchTypeOf<{ role: "user" } | { role: "assistant" } | { role: "toolResult" }>();
	});
});
