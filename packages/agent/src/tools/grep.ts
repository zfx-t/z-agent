/**
 * Search file contents. Prefer `rg` on PATH; otherwise walk + JS match.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { AgentTool, AgentToolResult } from "../types.ts";
import { type CodingToolsOptions, resolveJailRoot, throwIfAborted } from "./options.ts";
import { resolveToolPath } from "./path.ts";
import { truncateTail, truncationNotice } from "./truncate.ts";
import { isDirectory, walkFiles } from "./walk.ts";

const grepSchema = z.object({
	pattern: z.string().describe("Regular expression to search for"),
	path: z.string().optional().describe("File or directory to search (default: working directory)"),
});

export interface GrepToolDetails {
	matches: number;
	usedRipgrep: boolean;
}

function compilePattern(pattern: string): RegExp {
	try {
		return new RegExp(pattern);
	} catch {
		throw new Error(`Invalid regular expression: ${pattern}`);
	}
}

async function tryRipgrep(pattern: string, searchRoot: string, signal?: AbortSignal): Promise<string | undefined> {
	return await new Promise((resolve) => {
		const child = spawn("rg", ["-n", "--no-heading", "--color", "never", "-e", pattern, searchRoot], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const chunks: Buffer[] = [];
		child.stdout?.on("data", (data: Buffer) => {
			chunks.push(data);
		});
		const onAbort = () => {
			child.kill("SIGKILL");
		};
		if (signal) {
			if (signal.aborted) {
				onAbort();
			} else {
				signal.addEventListener("abort", onAbort, { once: true });
			}
		}
		child.once("error", () => {
			resolve(undefined);
		});
		child.once("close", (code) => {
			signal?.removeEventListener("abort", onAbort);
			if (code === 0 || code === 1) {
				resolve(Buffer.concat(chunks).toString("utf-8"));
				return;
			}
			resolve(undefined);
		});
	});
}

async function nodeGrep(pattern: string, searchRoot: string, signal?: AbortSignal): Promise<string> {
	const regex = compilePattern(pattern);
	const lines: string[] = [];
	const rootIsDir = await isDirectory(searchRoot);
	if (!rootIsDir) {
		const text = await readFile(searchRoot, "utf-8");
		const fileLines = text.split("\n");
		for (let i = 0; i < fileLines.length; i++) {
			if (regex.test(fileLines[i])) {
				lines.push(`${searchRoot}:${i + 1}:${fileLines[i]}`);
			}
		}
		return lines.join("\n");
	}

	await walkFiles(searchRoot, signal, async (abs, rel) => {
		let text: string;
		try {
			text = await readFile(abs, "utf-8");
		} catch {
			return;
		}
		if (text.includes("\u0000")) {
			return;
		}
		const fileLines = text.split("\n");
		for (let i = 0; i < fileLines.length; i++) {
			if (regex.test(fileLines[i])) {
				lines.push(`${rel}:${i + 1}:${fileLines[i]}`);
			}
		}
	});
	return lines.join("\n");
}

export function createGrepTool(
	cwd: string,
	options: CodingToolsOptions = {},
): AgentTool<typeof grepSchema, GrepToolDetails> {
	const jailRoot = resolveJailRoot(cwd, options.jailRoot);
	return {
		name: "grep",
		label: "Grep",
		description: "Search file contents with a regular expression. Uses ripgrep when available.",
		parameters: grepSchema,
		async execute(_toolCallId, params, signal): Promise<AgentToolResult<GrepToolDetails>> {
			throwIfAborted(signal);
			compilePattern(params.pattern);
			const searchRoot = await resolveToolPath(params.path ?? ".", cwd, jailRoot);
			const rgOut = await tryRipgrep(params.pattern, searchRoot, signal);
			const usedRipgrep = rgOut !== undefined;
			const raw = usedRipgrep ? rgOut : await nodeGrep(params.pattern, searchRoot, signal);
			const truncation = truncateTail(raw);
			const notice = truncationNotice(truncation, "tail");
			const matches = raw.length === 0 ? 0 : raw.split("\n").filter((line) => line.length > 0).length;
			const body = truncation.content.length > 0 ? truncation.content : "(no matches)";
			const parts = [body];
			if (notice) {
				parts.push(notice);
			}
			return {
				content: [{ type: "text", text: parts.join("\n") }],
				details: { matches, usedRipgrep },
			};
		},
	};
}
