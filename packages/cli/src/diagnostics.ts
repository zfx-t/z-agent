/**
 * Structured JSONL diagnostics sink (ADR-0031).
 *
 * Enabled by `--debug` or `PILLOW_DEBUG=1|verbose`; a disabled sink is a true
 * no-op — no directory creation, no file handle, `log()` returns immediately.
 * Records are `{ ts, seq, kind, sessionId, ...fields }` appended under
 * `~/.pillow/logs/<YYYY-MM-DD>/<sessionId>.jsonl` (dirs 0700, files 0600).
 * `redact` runs over every record's fields, so keys like `apiKey` or values
 * like `sk-…` never reach the file — not even in verbose mode.
 */

import { appendFile, chmod, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentEvent } from "@z-agent/agent";

export type DiagnosticsMode = "off" | "on" | "verbose";

export interface DiagnosticsRecord {
	ts: string;
	seq: number;
	kind: string;
	sessionId: string;
	[key: string]: unknown;
}

/** Minimal Dirent surface so tests can fake readdir without node types. */
export interface DiagnosticsDirEntry {
	name: string;
	isDirectory(): boolean;
}

export interface DiagnosticsFs {
	mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
	appendFile(path: string, data: string): Promise<void>;
	readdir(path: string): Promise<DiagnosticsDirEntry[]>;
	rm(path: string, options: { recursive: true; force: true }): Promise<void>;
	chmod(path: string, mode: number): Promise<void>;
}

export interface DiagnosticsDeps {
	mode: DiagnosticsMode;
	/** pillowLogsDir(userPillow). */
	logsDir: string;
	sessionId: string;
	now?: () => Date;
	fs?: DiagnosticsFs;
	/** First write failure is reported here once; later failures stay silent. */
	warn?: (line: string) => void;
	/** Live thinking level for provider.request records (`/model` may change it). */
	thinkingLevel?: () => string;
}

export interface Diagnostics {
	readonly enabled: boolean;
	readonly mode: DiagnosticsMode;
	readonly path?: string;
	/** Sync enqueue; writes are serialised on an internal promise chain. */
	log(kind: string, fields?: Record<string, unknown>): void;
	/** Maps AgentEvents onto provider.request/response, tool.*, loop.turn records. */
	onAgentEvent(event: AgentEvent): void;
	flush(): Promise<void>;
}

const nodeFs: DiagnosticsFs = {
	mkdir: (path, options) => mkdir(path, options),
	appendFile: (path, data) => appendFile(path, data, "utf8"),
	readdir: async (path) => await readdir(path, { withFileTypes: true }),
	rm: (path, options) => rm(path, options),
	chmod: (path, mode) => chmod(path, mode),
};

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const SECRET_KEY_PATTERN = /api[-_]?key|authorization|x-api-key|token|secret|password/iu;
/** Boundary + known secret-token shape; matches mid-string so e.g. an echoed
 * `key sk-…` inside an errorMessage is still scrubbed. `ask-…` does not match. */
const SECRET_VALUE_PATTERN = /(^|[^A-Za-z0-9])(?:sk|sk-ant|ghp|gho|xox[abp])-[A-Za-z0-9_-]{8,}/gu;

/**
 * A pattern match only counts when it aligns to a key segment boundary
 * (start/end, `-`/`_`, or a camelCase hump) so `estTokens`/`totalTokens`
 * survive while `accessToken`/`session_secret` still redact.
 */
function isSecretKey(key: string): boolean {
	const match = SECRET_KEY_PATTERN.exec(key);
	if (match === null) {
		return false;
	}
	const start = match.index;
	const end = start + match[0].length;
	const startBoundary = start === 0 || key[start - 1] === "-" || key[start - 1] === "_" || /[A-Z]/u.test(key[start]);
	const endBoundary = end === key.length || key[end] === "-" || key[end] === "_" || /[A-Z]/u.test(key[end]);
	return startBoundary && endBoundary;
}

function isPlainObject(value: object): boolean {
	const proto: unknown = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/** Deep-copies plain data, replacing secret keys/values with "[redacted]". */
export function redact<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
	if (typeof value === "string") {
		return value.replace(SECRET_VALUE_PATTERN, (_match, boundary: string) => `${boundary}[redacted]`) as T;
	}
	if (Array.isArray(value)) {
		if (seen.has(value)) {
			return "[circular]" as T;
		}
		seen.add(value);
		return value.map((item) => redact(item, seen)) as T;
	}
	if (typeof value === "object" && value !== null) {
		if (!isPlainObject(value) || seen.has(value)) {
			return seen.has(value) ? ("[circular]" as T) : value;
		}
		seen.add(value);
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			out[key] = isSecretKey(key) ? "[redacted]" : redact(item, seen);
		}
		return out as T;
	}
	return value;
}

// ---------------------------------------------------------------------------
// Path layout + rotation
// ---------------------------------------------------------------------------

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

function dayKey(date: Date): string {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

export function logPathFor(logsDir: string, sessionId: string, now: Date): string {
	return join(logsDir, dayKey(now), `${sessionId}.jsonl`);
}

/**
 * Deletes day-directories older than `keepDays` and keeps the newest
 * `keepFiles` `*.jsonl` (by name) inside the current day. Nothing outside
 * `logsDir`, no non-`YYYY-MM-DD` directory, and no non-`.jsonl` file is ever
 * removed.
 */
export async function rotateLogs(
	logsDir: string,
	now: Date,
	fs: DiagnosticsFs,
	keepDays = 7,
	keepFiles = 50,
): Promise<void> {
	let entries: DiagnosticsDirEntry[];
	try {
		entries = await fs.readdir(logsDir);
	} catch {
		return;
	}
	const cutoff = dayKey(new Date(now.getTime() - keepDays * 86_400_000));
	for (const entry of entries) {
		if (entry.isDirectory() && DAY_PATTERN.test(entry.name) && entry.name < cutoff) {
			await fs.rm(join(logsDir, entry.name), { recursive: true, force: true });
		}
	}
	let dayEntries: DiagnosticsDirEntry[];
	try {
		dayEntries = await fs.readdir(join(logsDir, dayKey(now)));
	} catch {
		return;
	}
	const jsonl = dayEntries
		.filter((entry) => !entry.isDirectory() && entry.name.endsWith(".jsonl"))
		.map((entry) => entry.name)
		.sort();
	for (const name of jsonl.slice(0, Math.max(0, jsonl.length - keepFiles))) {
		await fs.rm(join(logsDir, dayKey(now), name), { recursive: true, force: true });
	}
}

/** `--debug` wins; otherwise `PILLOW_DEBUG=verbose|1|true|on`. */
export function resolveDiagnosticsMode(flag: boolean, env: NodeJS.ProcessEnv): DiagnosticsMode {
	if (flag) {
		return "on";
	}
	const raw = env.PILLOW_DEBUG?.trim().toLowerCase();
	if (raw === "verbose") {
		return "verbose";
	}
	if (raw === "1" || raw === "true" || raw === "on") {
		return "on";
	}
	return "off";
}

// ---------------------------------------------------------------------------
// Sink
// ---------------------------------------------------------------------------

function textChars(content: unknown): number {
	if (!Array.isArray(content)) {
		return 0;
	}
	let total = 0;
	for (const block of content) {
		if (typeof block === "object" && block !== null && "type" in block && block.type === "text" && "text" in block) {
			const text = (block as { text?: unknown }).text;
			if (typeof text === "string") {
				total += text.length;
			}
		}
	}
	return total;
}

function argKeys(args: unknown): string[] {
	if (typeof args === "object" && args !== null && !Array.isArray(args)) {
		return Object.keys(args);
	}
	return [];
}

function jsonChars(value: unknown): number {
	try {
		return JSON.stringify(value)?.length ?? 0;
	} catch {
		return 0;
	}
}

export function createDiagnostics(deps: DiagnosticsDeps): Diagnostics {
	const fs = deps.fs ?? nodeFs;
	const now = deps.now ?? (() => new Date());
	if (deps.mode === "off") {
		return {
			enabled: false,
			mode: "off",
			log() {},
			onAgentEvent() {},
			flush: () => Promise.resolve(),
		};
	}

	const warn = deps.warn ?? ((line: string) => process.stderr.write(`[diagnostics] ${line}\n`));
	const path = logPathFor(deps.logsDir, deps.sessionId, now());
	const dayDir = dirname(path);
	let seq = 0;
	let dirReady = false;
	let chmodDone = false;
	let warned = false;
	let queue: Promise<void> = Promise.resolve();

	const enqueue = (task: () => Promise<void>): void => {
		queue = queue.then(task).catch((error: unknown) => {
			if (!warned) {
				warned = true;
				warn(`log write failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		});
	};

	// Rotation shares the write queue so it can never race an append.
	enqueue(async () => {
		await rotateLogs(deps.logsDir, now(), fs);
	});

	const writeLine = async (line: string): Promise<void> => {
		if (!dirReady) {
			await fs.mkdir(dayDir, { recursive: true, mode: 0o700 });
			dirReady = true;
		}
		await fs.appendFile(path, line);
		if (!chmodDone) {
			await fs.chmod(path, 0o600);
			chmodDone = true;
		}
	};

	const log = (kind: string, fields: Record<string, unknown> = {}): void => {
		const record: DiagnosticsRecord = {
			ts: now().toISOString(),
			seq: ++seq,
			kind,
			sessionId: deps.sessionId,
			...redact(fields),
		};
		let line: string;
		try {
			line = `${JSON.stringify(record)}\n`;
		} catch {
			line = `${JSON.stringify({ ts: record.ts, seq: record.seq, kind, sessionId: record.sessionId, unserializable: true })}\n`;
		}
		enqueue(() => writeLine(line));
	};

	// ---- AgentEvent mapping state -------------------------------------------
	let turn = 0;
	let inTurn = false;
	let injectedThisTurn = 0;
	let prevTurnHadToolCalls = false;
	let requestStartedAt: number | undefined;
	let contextMessages = 0;
	let contextChars = 0;
	const toolStarts = new Map<string, number>();

	const onAgentEvent = (event: AgentEvent): void => {
		switch (event.type) {
			case "agent_start": {
				turn = 0;
				inTurn = false;
				injectedThisTurn = 0;
				prevTurnHadToolCalls = false;
				requestStartedAt = undefined;
				contextMessages = 0;
				contextChars = 0;
				toolStarts.clear();
				break;
			}
			case "turn_start": {
				turn += 1;
				inTurn = true;
				injectedThisTurn = 0;
				requestStartedAt = undefined;
				break;
			}
			case "message_start": {
				const role = (event.message as { role?: unknown }).role;
				if (role === "assistant") {
					const message = event.message as { model?: unknown; api?: unknown };
					requestStartedAt = now().getTime();
					log("provider.request", {
						turn,
						model: message.model,
						api: message.api,
						messages: contextMessages,
						estTokens: Math.ceil(contextChars / 4),
						thinking: deps.thinkingLevel?.() ?? "off",
					});
				} else if (role === "user" && inTurn && turn > 1) {
					// Turn-1 user message_starts are the submitted prompts; later ones
					// are queue injections (steering or follow-up).
					injectedThisTurn += 1;
				}
				break;
			}
			case "message_end": {
				contextMessages += 1;
				contextChars += jsonChars(event.message);
				const message = event.message;
				if (message.role === "assistant") {
					const fields: Record<string, unknown> = {
						turn,
						stopReason: message.stopReason,
						durationMs: requestStartedAt === undefined ? 0 : Math.max(0, now().getTime() - requestStartedAt),
						usage: {
							input: message.usage.input,
							output: message.usage.output,
							cacheRead: message.usage.cacheRead,
							cacheWrite: message.usage.cacheWrite,
						},
					};
					if (message.errorMessage !== undefined) {
						fields.errorMessage = message.errorMessage;
					}
					if (deps.mode === "verbose") {
						fields.textChars = textChars(message.content);
					}
					log("provider.response", fields);
				}
				break;
			}
			case "tool_execution_start": {
				toolStarts.set(event.toolCallId, now().getTime());
				const fields: Record<string, unknown> = {
					toolCallId: event.toolCallId,
					name: event.toolName,
					argKeys: argKeys(event.args),
				};
				if (deps.mode === "verbose") {
					fields.argsChars = jsonChars(event.args);
				}
				log("tool.start", fields);
				break;
			}
			case "tool_execution_end": {
				const started = toolStarts.get(event.toolCallId);
				toolStarts.delete(event.toolCallId);
				log("tool.end", {
					toolCallId: event.toolCallId,
					name: event.toolName,
					durationMs: started === undefined ? 0 : Math.max(0, now().getTime() - started),
					isError: event.isError,
					outputChars: textChars(event.result.content),
				});
				break;
			}
			case "turn_end": {
				const content = (event.message as { content?: unknown }).content;
				const hasToolCalls =
					Array.isArray(content) && content.some((block) => (block as { type?: unknown }).type === "toolCall");
				// Steering drains between two turns only when the previous turn ran
				// tools; after a no-tool turn the inner loop exits and the follow-up
				// poll produces the injection. (A steering drain that happens to land
				// after a quiet turn is indistinguishable from the event stream.)
				const steeringDrained = injectedThisTurn > 0 && prevTurnHadToolCalls ? injectedThisTurn : 0;
				const followUpDrained = injectedThisTurn > 0 && !prevTurnHadToolCalls ? injectedThisTurn : 0;
				log("loop.turn", { turn, hasToolCalls, steeringDrained, followUpDrained });
				prevTurnHadToolCalls = hasToolCalls;
				inTurn = false;
				break;
			}
			case "agent_end": {
				inTurn = false;
				break;
			}
			default:
				break;
		}
	};

	return {
		enabled: true,
		mode: deps.mode,
		path,
		log,
		onAgentEvent,
		flush: () => queue,
	};
}
