import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { AgentTool, AgentToolResult } from "../types.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { type CodingToolsOptions, resolveJailRoot, throwIfAborted } from "./options.ts";
import { resolveToolPath } from "./path.ts";

const writeSchema = z.object({
	path: z.string().describe("Path to the file to write (relative or absolute)"),
	content: z.string().describe("Content to write to the file"),
});

export interface WriteToolDetails {
	path: string;
	bytes: number;
}

export function createWriteTool(
	cwd: string,
	options: CodingToolsOptions = {},
): AgentTool<typeof writeSchema, WriteToolDetails> {
	const jailRoot = resolveJailRoot(cwd, options.jailRoot);
	return {
		name: "write",
		label: "Write",
		description: "Create or overwrite a file. Creates parent directories as needed.",
		parameters: writeSchema,
		async execute(_toolCallId, params, signal): Promise<AgentToolResult<WriteToolDetails>> {
			throwIfAborted(signal);
			const absolutePath = await resolveToolPath(params.path, cwd, jailRoot);
			return await withFileMutationQueue(absolutePath, async () => {
				throwIfAborted(signal);
				await mkdir(dirname(absolutePath), { recursive: true });
				throwIfAborted(signal);
				await writeFile(absolutePath, params.content, "utf-8");
				const bytes = Buffer.byteLength(params.content, "utf-8");
				return {
					content: [{ type: "text", text: `Wrote ${bytes} bytes to ${params.path}` }],
					details: { path: absolutePath, bytes },
				};
			});
		},
	};
}
