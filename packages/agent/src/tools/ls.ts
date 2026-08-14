import { z } from "zod";
import type { AgentTool, AgentToolResult } from "../types.ts";
import { type CodingToolsOptions, resolveJailRoot, throwIfAborted } from "./options.ts";
import { resolveToolPath } from "./path.ts";
import { listDirectory } from "./walk.ts";

const lsSchema = z.object({
	path: z.string().optional().describe("Directory to list (default: working directory)"),
});

export interface LsToolDetails {
	path: string;
	count: number;
}

export function createLsTool(cwd: string, options: CodingToolsOptions = {}): AgentTool<typeof lsSchema, LsToolDetails> {
	const jailRoot = resolveJailRoot(cwd, options.jailRoot);
	return {
		name: "ls",
		label: "Ls",
		description: "List files and directories in a path.",
		parameters: lsSchema,
		async execute(_toolCallId, params, signal): Promise<AgentToolResult<LsToolDetails>> {
			throwIfAborted(signal);
			const absolutePath = await resolveToolPath(params.path ?? ".", cwd, jailRoot);
			const names = await listDirectory(absolutePath);
			return {
				content: [{ type: "text", text: names.length > 0 ? names.join("\n") : "(empty)" }],
				details: { path: absolutePath, count: names.length },
			};
		},
	};
}
