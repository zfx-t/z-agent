/**
 * Read text (numbered) or images (jpg/png/gif/webp via magic bytes).
 */

import { constants, createReadStream } from "node:fs";
import { access, open, readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { z } from "zod";
import type { AgentTool, AgentToolResult, ImageContent, TextContent } from "../types.ts";
import { detectImageMimeType } from "./mime.ts";
import { type CodingToolsOptions, resolveJailRoot, throwIfAborted } from "./options.ts";
import { resolveToolPath } from "./path.ts";
import { DEFAULT_MAX_LINES, truncateHead, truncationNotice } from "./truncate.ts";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

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

async function readTextLineSlice(
	absolutePath: string,
	startLine: number,
	limit: number | undefined,
	signal?: AbortSignal,
): Promise<{ lines: string[]; totalLines: number }> {
	const stream = createReadStream(absolutePath, { encoding: "utf-8" });
	const rl = createInterface({ input: stream, crlfDelay: Infinity });
	const lines: string[] = [];
	let totalLines = 0;
	const maxCollect = limit !== undefined ? limit : DEFAULT_MAX_LINES;
	try {
		for await (const line of rl) {
			throwIfAborted(signal);
			totalLines += 1;
			if (totalLines < startLine) {
				continue;
			}
			if (lines.length < maxCollect) {
				lines.push(line);
			}
			if (lines.length >= maxCollect) {
				break;
			}
		}
	} finally {
		rl.close();
		stream.destroy();
	}
	if (totalLines === 0 && startLine === 1) {
		return { lines: [""], totalLines: 1 };
	}
	return { lines, totalLines };
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
			const fileStat = await stat(absolutePath);
			const head = Buffer.alloc(Math.min(16, fileStat.size));
			if (head.length > 0) {
				const handle = await open(absolutePath, "r");
				try {
					await handle.read(head, 0, head.length, 0);
				} finally {
					await handle.close();
				}
			}
			throwIfAborted(signal);

			const mimeType = detectImageMimeType(head);
			if (mimeType) {
				if (fileStat.size > MAX_IMAGE_BYTES) {
					throw new Error(`Image too large to read (${fileStat.size} bytes): ${params.path}`);
				}
				const buffer = await readFile(absolutePath);
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

			const startLine = params.offset !== undefined ? Math.max(1, Math.floor(params.offset)) : 1;
			let limit: number | undefined;
			if (params.limit !== undefined) {
				limit = Math.floor(params.limit);
				if (limit < 0) {
					throw new Error("limit must be a non-negative number");
				}
			}
			const slice = await readTextLineSlice(absolutePath, startLine, limit, signal);
			if (slice.totalLines < startLine) {
				throw new Error(`offset ${startLine} is past the end of ${params.path} (${slice.totalLines} lines)`);
			}

			const numbered = formatNumberedLines(slice.lines, startLine);
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
