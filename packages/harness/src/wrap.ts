import type { AgentTool, AgentToolResult } from "@z-agent/agent";
import type { AssistantMessageEventStream, Context, Model, StreamFn, StreamOptions } from "@z-agent/ai";
import { withSandwich } from "./sandwich.ts";
import type { OpStore } from "./store.ts";

export function wrapTools(tools: AgentTool[], store: OpStore): AgentTool[] {
	return tools.map((tool) => ({
		...tool,
		async execute(toolCallId, params, signal, onUpdate): Promise<AgentToolResult> {
			return await withSandwich(store, `tool:${toolCallId}`, "tool", { name: tool.name, params }, () =>
				tool.execute(toolCallId, params, signal, onUpdate),
			);
		},
	}));
}

export function wrapStreamFn(streamFn: StreamFn, store: OpStore): StreamFn {
	return async (model: Model, context: Context, options?: StreamOptions): Promise<AssistantMessageEventStream> => {
		const opId = `stream:${options?.sessionId ?? "anon"}:${context.messages.length}`;
		return await withSandwich(store, opId, "stream", { model: model.id, size: context.messages.length }, () =>
			Promise.resolve(streamFn(model, context, options)),
		);
	};
}
