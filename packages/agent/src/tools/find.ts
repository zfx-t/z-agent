import { z } from "zod";
import type { AgentTool, AgentToolResult } from "../types.ts";
import { type CodingToolsOptions, resolveJailRoot, throwIfAborted } from "./options.ts";
import { resolveToolPath } from "./path.ts";
import { truncateTail, truncationNotice } from "./truncate.ts";
import { walkFiles } from "./walk.ts";

const findSchema = z.object({
	pattern: z.string().describe("Filename substring or glob (* and ?)"),
	path: z.string().optional().describe("Directory to search (default: working directory)"),
});

export interface FindToolDetails {
	matches: number;
}

function globToRegExp(pattern: string): RegExp {
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(escaped, "i");
}

export function createFindTool(
	cwd: string,
	options: CodingToolsOptions = {},
): AgentTool<typeof findSchema, FindToolDetails> {
	const jailRoot = resolveJailRoot(cwd, options.jailRoot);
	return {
		name: "find",
		label: "Find",
		description: "Find files by name substring or glob under a directory.",
		parameters: findSchema,
		async execute(_toolCallId, params, signal): Promise<AgentToolResult<FindToolDetails>> {
			throwIfAborted(signal);
			const searchRoot = await resolveToolPath(params.path ?? ".", cwd, jailRoot);
			const regex = globToRegExp(params.pattern);
			const hits: string[] = [];
			await walkFiles(searchRoot, signal, (_abs, rel) => {
				const base = rel.split("/").pop() ?? rel;
				if (regex.test(base) || regex.test(rel)) {
					hits.push(rel);
				}
			});
			const raw = hits.join("\n");
			const truncation = truncateTail(raw);
			const notice = truncationNotice(truncation, "tail");
			const body = truncation.content.length > 0 ? truncation.content : "(no matches)";
			const parts = [body];
			if (notice) {
				parts.push(notice);
			}
			return {
				content: [{ type: "text", text: parts.join("\n") }],
				details: { matches: hits.length },
			};
		},
	};
}
