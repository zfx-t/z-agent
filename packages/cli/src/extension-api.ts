import type { AgentEvent, AgentEventType, AgentTool } from "@z-agent/agent";
import type { TuiToolRenderer } from "@z-agent/tui";
import type { InteractiveCommand } from "./command-types.ts";
import type { StatusSegment } from "./status-segments.ts";

export type ExtensionEventHandler = (event: AgentEvent) => void | Promise<void>;

export interface ExtensionApi {
	registerCommand(command: Omit<InteractiveCommand, "source"> & { source?: InteractiveCommand["source"] }): void;
	registerTool(tool: AgentTool): void;
	registerStatusSegment(segment: StatusSegment): void;
	registerToolRenderer(toolName: string, render: TuiToolRenderer): void;
	on(type: AgentEventType | "*", handler: ExtensionEventHandler): void;
}
