/**
 * Read text (numbered) or images (jpg/png/gif/webp via magic bytes).
 */

import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { z } from "zod";
import type { AgentTool, AgentToolResult, ImageContent, TextContent } from "../types.ts";
import { detectImageMimeType } from "./mime.ts";
import { type CodingToolsOptions, resolveJailRoot, throwIfAborted } from "./options.ts";
import { resolveToolPath } from "./path.ts";
import { truncateHead, truncationNotice } from "./truncate.ts";

const readSchema = z.object({
	path: z.string().describe("Path to the file to read (relative or absolute)"),
	offset: z.number().optional().describe("Line number to start reading from (1-indexed)"),
	limit: z.number().optional().describe("Maximum number of lines to read"),
});

export interface ReadToolDetails {
	path: string;
	truncated?: boolean;
	mimeType?: string;
}

function formatNumberedLines(lines: string[], startLine: number): string {
	if (lines.length === 0) {
		return "";
	}
	const lastNumber = startLine + lines.length - 1;
	const width = String(lastNumber).length;
	return lines.map((line, index) => `${String(startLine + index).padStart(width)}|${line}`).join("\n");
}

export function createReadTool(
	cwd: string,
	options: CodingToolsOptions = {},
): AgentTool<typeof readSchema, ReadToolDetails> {
	const jailRoot = resolveJailRoot(cwd, options.jailRoot);
	return {
		name: "read",
		label: "Read",
		description:
			"Read a text file (numbered, truncated) or an image (jpg/png/gif/webp). Use offset/limit for large text files.",
		parameters: readSchema,
		async execute(_toolCallId, params, signal): Promise<AgentToolResult<ReadToolDetails>> {
			throwIfAborted(signal);
			const absolutePath = await resolveToolPath(params.path, cwd, jailRoot);
			await access(absolutePath, constants.R_OK);
			throwIfAborted(signal);
			const buffer = await readFile(absolutePath);
			throwIfAborted(signal);

			const mimeType = detectImageMimeType(buffer);
			if (mimeType) {
				const image: ImageContent = {
					type: "image",
					data: buffer.toString("base64"),
					mimeType,
				};
				const note: TextContent = { type: "text", text: `Read image file [${mimeType}] ${params.path}` };
				return {
					content: [note, image],
					details: { path: absolutePath, mimeType },
				};
			}

			const raw = buffer.toString("utf-8");
			const allLines = raw.split("\n");
			if (raw.endsWith("\n") && allLines[allLines.length - 1] === "") {
				allLines.pop();
			}

			const startLine = params.offset !== undefined ? Math.max(1, Math.floor(params.offset)) : 1;
			const startIndex = startLine - 1;
			if (startIndex >= allLines.length) {
				throw new Error(`offset ${startLine} is past the end of ${params.path} (${allLines.length} lines)`);
			}

			let slice = allLines.slice(startIndex);
			if (params.limit !== undefined) {
				const limit = Math.floor(params.limit);
				if (limit < 0) {
					throw new Error("limit must be a non-negative number");
				}
				slice = slice.slice(0, limit);
			}

			const numbered = formatNumberedLines(slice, startLine);
			const truncation = truncateHead(numbered);
			const notice = truncationNotice(truncation, "head");
			const text = notice ? `${truncation.content}\n${notice}` : truncation.content;

			return {
				content: [{ type: "text", text }],
				details: { path: absolutePath, truncated: truncation.truncated },
			};
		},
	};
}
