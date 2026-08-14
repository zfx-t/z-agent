/**
 * Run a shell command in cwd. Abort kills the process tree (Win taskkill / POSIX -pid).
 */

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { z } from "zod";
import type { AgentTool, AgentToolResult } from "../types.ts";
import { defaultKillProcessTree, killProcessTree, type ProcessKiller } from "./kill-process-tree.ts";
import { type CodingToolsOptions, resolveJailRoot, throwIfAborted } from "./options.ts";
import { resolveToolPath } from "./path.ts";
import { DEFAULT_MAX_BYTES, truncateTail, truncationNotice } from "./truncate.ts";

const bashSchema = z.object({
	command: z.string().describe("Bash command to execute"),
	timeout: z.number().optional().describe("Timeout in seconds (optional, no default timeout)"),
});

export interface BashToolDetails {
	exitCode: number | null;
	truncated?: boolean;
}

export interface BashToolOptions extends CodingToolsOptions {
	/** Injected killer for tests. */
	kill?: ProcessKiller;
}

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) {
		return undefined;
	}
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}
	const timeoutMs = timeout * 1000;
	if (timeoutMs > 2_147_483_647) {
		throw new Error("Invalid timeout: too large");
	}
	return timeoutMs;
}

async function runCommand(
	command: string,
	cwd: string,
	signal: AbortSignal | undefined,
	timeoutMs: number | undefined,
	kill: ProcessKiller,
): Promise<{ exitCode: number | null; output: string }> {
	throwIfAborted(signal);

	const shell = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "/bin/bash";
	const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
	const child = spawn(shell, args, {
		cwd,
		detached: process.platform !== "win32",
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});

	const chunks: Buffer[] = [];
	let captured = 0;
	const onData = (data: Buffer) => {
		chunks.push(data);
		captured += data.length;
		while (captured > DEFAULT_MAX_BYTES && chunks.length > 0) {
			const overflow = captured - DEFAULT_MAX_BYTES;
			const first = chunks[0];
			if (!first) {
				break;
			}
			if (first.length <= overflow) {
				chunks.shift();
				captured -= first.length;
			} else {
				chunks[0] = first.subarray(overflow);
				captured -= overflow;
			}
		}
	};
	child.stdout?.on("data", onData);
	child.stderr?.on("data", onData);

	let timedOut = false;
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	const onAbort = () => {
		if (child.pid) {
			killProcessTree(child.pid, kill);
		}
	};

	if (signal) {
		if (signal.aborted) {
			onAbort();
		} else {
			signal.addEventListener("abort", onAbort, { once: true });
		}
	}
	if (timeoutMs !== undefined) {
		timeoutHandle = setTimeout(() => {
			timedOut = true;
			onAbort();
		}, timeoutMs);
	}

	try {
		const exitCode = await new Promise<number | null>((resolve, reject) => {
			child.once("error", (error) => {
				reject(error);
			});
			child.once("close", (code) => {
				resolve(code);
			});
		});
		throwIfAborted(signal);
		if (timedOut) {
			const seconds = (timeoutMs ?? 0) / 1000;
			throw new Error(`Timed out after ${seconds} seconds`);
		}
		return {
			exitCode,
			output: Buffer.concat(chunks).toString("utf-8"),
		};
	} finally {
		if (timeoutHandle) {
			clearTimeout(timeoutHandle);
		}
		signal?.removeEventListener("abort", onAbort);
	}
}

export function createBashTool(
	cwd: string,
	options: BashToolOptions = {},
): AgentTool<typeof bashSchema, BashToolDetails> {
	const jailRoot = resolveJailRoot(cwd, options.jailRoot);
	const kill = options.kill ?? defaultKillProcessTree;
	return {
		name: "bash",
		label: "Bash",
		description:
			"Execute a bash command in the working directory. Returns stdout and stderr. Output is truncated to the last 2000 lines or 50KB. Jail (when enabled) only requires the working directory to be inside the jail; the command itself can still access paths outside it.",
		parameters: bashSchema,
		async execute(_toolCallId, params, signal): Promise<AgentToolResult<BashToolDetails>> {
			const timeoutMs = resolveTimeoutMs(params.timeout);
			if (jailRoot !== false) {
				await resolveToolPath(".", cwd, jailRoot);
			}
			try {
				await access(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}`);
			}
			const { exitCode, output } = await runCommand(params.command, cwd, signal, timeoutMs, kill);
			const truncation = truncateTail(output);
			const notice = truncationNotice(truncation, "tail");
			const body = truncation.content.length > 0 ? truncation.content : "(no output)";
			const parts = [`exit ${exitCode ?? "null"}`, body];
			if (notice) {
				parts.push(notice);
			}
			return {
				content: [{ type: "text", text: parts.join("\n") }],
				details: { exitCode, truncated: truncation.truncated },
			};
		},
	};
}
