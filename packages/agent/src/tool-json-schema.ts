/**
 * Convert agent-layer zod tools to LLM-boundary JSON Schema tools (ADR-0013, ADR-0015).
 */

import type { Tool } from "@z-agent/ai";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { AgentTool } from "./types.ts";

function zodSchemaToJsonSchemaObject(schema: AgentTool["parameters"]): Record<string, unknown> {
	const jsonSchema = zodToJsonSchema(schema, {
		$refStrategy: "none",
		target: "jsonSchema7",
	});
	if (typeof jsonSchema === "object" && jsonSchema !== null && !Array.isArray(jsonSchema)) {
		const { $schema: _schema, ...rest } = jsonSchema as Record<string, unknown>;
		return rest;
	}
	return { type: "object", properties: {} };
}

/** Map AgentTool[] (zod) → Tool[] (JSON Schema parameters) for StreamFn Context. */
export function agentToolsToLlmTools(tools: readonly AgentTool[]): Tool[] {
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: zodSchemaToJsonSchemaObject(tool.parameters),
	}));
}
