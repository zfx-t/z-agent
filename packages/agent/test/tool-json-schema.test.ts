import { describe, expect, it } from "vitest";
import { z } from "zod";
import { agentToolsToLlmTools } from "../src/tool-json-schema.ts";
import type { AgentTool } from "../src/types.ts";

function echoTool(): AgentTool {
	const parameters = z.object({
		text: z.string().describe("Text to echo back"),
	});
	return {
		name: "echo",
		label: "Echo",
		description: "Echo text back to the conversation",
		parameters,
		async execute(_id, params) {
			return {
				content: [{ type: "text", text: String((params as { text: string }).text) }],
				details: {},
			};
		},
	};
}

describe("agentToolsToLlmTools", () => {
	it("converts a zod object tool to JSON Schema parameters", () => {
		const tools = agentToolsToLlmTools([echoTool()]);
		expect(tools).toHaveLength(1);
		const echo = tools[0];
		expect(echo).toMatchObject({
			name: "echo",
			description: "Echo text back to the conversation",
		});
		expect(echo?.parameters).toMatchObject({
			type: "object",
			properties: {
				text: { type: "string" },
			},
		});
		expect(echo?.parameters).not.toHaveProperty("$schema");
	});

	it("returns an empty array for no tools", () => {
		expect(agentToolsToLlmTools([])).toEqual([]);
	});
});
