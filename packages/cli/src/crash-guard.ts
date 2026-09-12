/**
 * Crash guard (ADR-0031): ordered shutdown for faults that would otherwise
 * leave the terminal in alt-screen/bracketed-paste and drop the session tail.
 *
 * Fixed order: (a) latch → (b) restoreTerminal → (c) persistSession raced
 * against a deadline → (d) crash record + bounded flush → (e) one stderr
 * line → (f) exit. A second fault while the first is in flight skips to
 * stderr+exit. SIGINT stays owned by SigintAbort — it is not handled here.
 */

export type CrashSource = "uncaughtException" | "unhandledRejection" | "main" | "SIGTERM" | "SIGHUP";

export interface CrashGuardDeps {
	restoreTerminal: () => void;
	persistSession: () => Promise<void>;
	log: (fields: Record<string, unknown>) => void;
	flush: () => Promise<void>;
	stderr: (line: string) => void;
	exit: (code: number) => void;
	logPath?: string;
	persistDeadlineMs?: number;
	flushDeadlineMs?: number;
	setTimeout?: typeof globalThis.setTimeout;
	clearTimeout?: typeof globalThis.clearTimeout;
}

export interface ProcessLike {
	on(event: string, listener: (...args: unknown[]) => void): unknown;
	off(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface CrashGuard {
	install(proc: ProcessLike): void;
	uninstall(): void;
	handle(source: CrashSource, error: unknown): Promise<void>;
}

export function exitCodeFor(source: CrashSource): number {
	if (source === "SIGTERM") {
		return 143;
	}
	if (source === "SIGHUP") {
		return 129;
	}
	return 1;
}

const DEFAULT_PERSIST_DEADLINE_MS = 2_000;
const DEFAULT_FLUSH_DEADLINE_MS = 500;

export function createCrashGuard(deps: CrashGuardDeps): CrashGuard {
	const persistDeadlineMs = deps.persistDeadlineMs ?? DEFAULT_PERSIST_DEADLINE_MS;
	const flushDeadlineMs = deps.flushDeadlineMs ?? DEFAULT_FLUSH_DEADLINE_MS;
	const setTimer = deps.setTimeout ?? globalThis.setTimeout;
	const clearTimer = deps.clearTimeout ?? globalThis.clearTimeout;
	let crashing = false;
	let installed: { proc: ProcessLike; listeners: [string, (...args: unknown[]) => void][] } | undefined;

	const stderrLine = (message: string): string =>
		`z-agent crashed: ${message}${deps.logPath ? ` (log: ${deps.logPath})` : " (rerun with --debug for a log)"}`;

	/** Resolves `fallback` when `work` rejects or outlives `ms`. Timer always cleared. */
	const withDeadline = <T>(work: Promise<T>, ms: number, fallback: T): Promise<T> =>
		new Promise<T>((resolve) => {
			const timer = setTimer(() => resolve(fallback), ms);
			work.then(
				(value) => {
					clearTimer(timer);
					resolve(value);
				},
				() => {
					clearTimer(timer);
					resolve(fallback);
				},
			);
		});

	const handle = async (source: CrashSource, error: unknown): Promise<void> => {
		const err =
			error instanceof Error ? error : new Error(error === undefined || error === null ? source : String(error));
		if (crashing) {
			deps.stderr(stderrLine(err.message));
			deps.exit(exitCodeFor(source));
			return;
		}
		crashing = true;
		let terminalRestored = false;
		try {
			deps.restoreTerminal();
			terminalRestored = true;
		} catch {
			// best effort: a broken tty must not block the rest of the shutdown
		}
		const sessionPersisted = await withDeadline(
			Promise.resolve()
				.then(() => deps.persistSession())
				.then(
					() => true,
					() => false,
				),
			persistDeadlineMs,
			false,
		);
		try {
			deps.log({
				source,
				message: err.message,
				...(err.stack !== undefined ? { stack: err.stack } : {}),
				terminalRestored,
				sessionPersisted,
			});
		} catch {
			// logging must never throw through the guard
		}
		await withDeadline(
			Promise.resolve().then(() => deps.flush()),
			flushDeadlineMs,
			undefined,
		);
		deps.stderr(stderrLine(err.message));
		deps.exit(exitCodeFor(source));
	};

	return {
		install(proc: ProcessLike): void {
			const listeners: [string, (...args: unknown[]) => void][] = [
				["uncaughtException", (error: unknown) => void handle("uncaughtException", error)],
				["unhandledRejection", (reason: unknown) => void handle("unhandledRejection", reason)],
				["SIGTERM", () => void handle("SIGTERM", undefined)],
				["SIGHUP", () => void handle("SIGHUP", undefined)],
			];
			for (const [event, listener] of listeners) {
				proc.on(event, listener);
			}
			installed = { proc, listeners };
		},
		uninstall(): void {
			if (!installed) {
				return;
			}
			for (const [event, listener] of installed.listeners) {
				installed.proc.off(event, listener);
			}
			installed = undefined;
		},
		handle,
	};
}
