/**
 * Run a shell command in cwd. Abort kills the process tree (Win taskkill / POSIX -pid).
 */

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { z } from "zod";
import type { AgentTool, AgentToolResult } from "../types.ts";
import { type BashEnvPolicy, buildChildEnv } from "./bash-env.ts";
import { defaultKillProcessTree, killProcessTree, type ProcessKiller } from "./kill-process-tree.ts";
import { type CodingToolsOptions, resolveJailRoot, throwIfAborted } from "./options.ts";
import { resolveToolPath } from "./path.ts";
import { DEFAULT_MAX_BYTES, truncateTail, truncationNotice } from "./truncate.ts";

const bashSchema = (timeout: BashTimeoutPolicy) =>
	z.object({
		command: z.string().describe("Bash command to execute"),
		timeout: z
			.number()
			.optional()
			.describe(
				`Timeout in seconds (default ${timeout.defaultSeconds}, max ${timeout.maxSeconds}). Long jobs: pass an explicit timeout or background the process.`,
			),
	});

export interface BashToolDetails {
	exitCode: number | null;
	truncated?: boolean;
}

export interface BashTimeoutPolicy {
	defaultSeconds: number;
	maxSeconds: number;
}

export const DEFAULT_BASH_TIMEOUT: BashTimeoutPolicy = { defaultSeconds: 600, maxSeconds: 3600 };

export interface BashToolOptions extends CodingToolsOptions {
	/** Injected killer for tests. */
	kill?: ProcessKiller;
	/** Child environment policy; default scrubs secret-shaped variables. */
	env?: BashEnvPolicy;
	/** Bash timeout defaults/cap; merged over {@link DEFAULT_BASH_TIMEOUT}. */
	timeout?: Partial<BashTimeoutPolicy>;
	/** Injected for tests; defaults to process.env. */
	sourceEnv?: NodeJS.ProcessEnv;
}

export function resolveTimeoutMs(
	requested: number | undefined,
	policy: BashTimeoutPolicy,
): { ms: number; clamped: boolean } {
	if (requested === undefined) {
		return { ms: Math.min(policy.defaultSeconds, policy.maxSeconds) * 1000, clamped: false };
	}
	if (!Number.isFinite(requested) || requested <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}
	const seconds = Math.min(requested, policy.maxSeconds);
	const timeoutMs = seconds * 1000;
	if (timeoutMs > 2_147_483_647) {
		throw new Error("Invalid timeout: too large");
	}
	return { ms: timeoutMs, clamped: seconds < requested };
}

async function runCommand(
	command: string,
	cwd: string,
	signal: AbortSignal | undefined,
	timeoutMs: number,
	env: NodeJS.ProcessEnv,
	kill: ProcessKiller,
): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
	throwIfAborted(signal);

	const shell = process.platform === "win32" ? (env.ComSpec ?? "cmd.exe") : "/bin/bash";
	const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
	const child = spawn(shell, args, {
		cwd,
		detached: process.platform !== "win32",
		env,
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
	timeoutHandle = setTimeout(() => {
		timedOut = true;
		onAbort();
	}, timeoutMs);

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
			return {
				exitCode: null,
				output: Buffer.concat(chunks).toString("utf-8"),
				timedOut: true,
			};
		}
		return {
			exitCode,
			output: Buffer.concat(chunks).toString("utf-8"),
			timedOut: false,
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
): AgentTool<ReturnType<typeof bashSchema>, BashToolDetails> {
	const jailRoot = resolveJailRoot(cwd, options.jailRoot);
	const kill = options.kill ?? defaultKillProcessTree;
	const timeoutPolicy: BashTimeoutPolicy = { ...DEFAULT_BASH_TIMEOUT, ...options.timeout };
	return {
		name: "bash",
		label: "Bash",
		description:
			"Execute a bash command in the working directory. Returns stdout and stderr. Output is truncated to the last 2000 lines or 50KB. Jail (when enabled) only requires the working directory to be inside the jail; the command itself can still access paths outside it.",
		parameters: bashSchema(timeoutPolicy),
		async execute(_toolCallId, params, signal): Promise<AgentToolResult<BashToolDetails>> {
			const { ms: timeoutMs, clamped } = resolveTimeoutMs(params.timeout, timeoutPolicy);
			if (jailRoot !== false) {
				await resolveToolPath(".", cwd, jailRoot);
			}
			try {
				await access(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}`);
			}
			const childEnv = buildChildEnv(options.sourceEnv ?? process.env, options.env, process.platform);
			const { exitCode, output, timedOut } = await runCommand(
				params.command,
				cwd,
				signal,
				timeoutMs,
				childEnv,
				kill,
			);
			const truncation = truncateTail(output);
			const notice = truncationNotice(truncation, "tail");
			const body = truncation.content.length > 0 ? truncation.content : "(no output)";
			const parts: string[] = [];
			if (clamped) {
				parts.push(`Note: timeout clamped to ${timeoutPolicy.maxSeconds}s.`);
			}
			if (timedOut) {
				parts.push(`Timed out after ${timeoutMs / 1000} seconds`, body);
			} else {
				parts.push(`exit ${exitCode ?? "null"}`, body);
			}
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
