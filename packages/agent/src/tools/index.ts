import type { AgentTool } from "../types.ts";
import { createBashTool } from "./bash.ts";
import { createEditTool } from "./edit.ts";
import { createFindTool } from "./find.ts";
import { createGrepTool } from "./grep.ts";
import { createLsTool } from "./ls.ts";
import type { CodingToolsOptions } from "./options.ts";
import { createReadTool } from "./read.ts";
import { createWriteTool } from "./write.ts";

export type { BashToolDetails, BashToolOptions } from "./bash.ts";
export { createBashTool } from "./bash.ts";
export type { EditToolDetails, FileEdit } from "./edit.ts";
export { applyEdits, createEditTool } from "./edit.ts";
export { withFileMutationQueue } from "./file-mutation-queue.ts";
export { createFindTool } from "./find.ts";
export type { GrepToolDetails, GrepToolOptions } from "./grep.ts";
export { createGrepTool } from "./grep.ts";
export { defaultKillProcessTree, killProcessTree, win32TaskkillArgs } from "./kill-process-tree.ts";
export { createLsTool } from "./ls.ts";
export { detectImageMimeType } from "./mime.ts";
export type { CodingToolsOptions } from "./options.ts";
export { assertInsideJail, resolveToCwd, resolveToolPath } from "./path.ts";
export { createReadTool } from "./read.ts";
export { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead, truncateTail } from "./truncate.ts";
export { createWriteTool } from "./write.ts";

export function createCodingTools(cwd: string, options: CodingToolsOptions = {}): AgentTool[] {
	return [
		createReadTool(cwd, options),
		createBashTool(cwd, options),
		createEditTool(cwd, options),
		createWriteTool(cwd, options),
	];
}

export function createAllTools(cwd: string, options: CodingToolsOptions = {}): AgentTool[] {
	return [
		...createCodingTools(cwd, options),
		createGrepTool(cwd, options),
		createFindTool(cwd, options),
		createLsTool(cwd, options),
	];
}
