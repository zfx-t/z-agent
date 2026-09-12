import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { type CrashGuardDeps, createCrashGuard, exitCodeFor } from "../src/crash-guard.ts";

interface FakeTimer {
	fn: () => void;
	ms: number;
	cleared: boolean;
}

function makeDeps(overrides: Partial<CrashGuardDeps> = {}) {
	const order: string[] = [];
	const stderrLines: string[] = [];
	const exits: number[] = [];
	const logged: Record<string, unknown>[] = [];
	const timers: FakeTimer[] = [];
	const deps: CrashGuardDeps = {
		restoreTerminal: () => {
			order.push("restoreTerminal");
		},
		persistSession: async () => {
			order.push("persistSession");
		},
		log: (fields) => {
			order.push("log");
			logged.push(fields);
		},
		flush: async () => {
			order.push("flush");
		},
		stderr: (line) => {
			order.push("stderr");
			stderrLines.push(line);
		},
		exit: (code) => {
			order.push("exit");
			exits.push(code);
		},
		setTimeout: ((fn: () => void, ms: number) => {
			const timer: FakeTimer = { fn, ms, cleared: false };
			timers.push(timer);
			return timer;
		}) as unknown as typeof globalThis.setTimeout,
		clearTimeout: ((timer: FakeTimer) => {
			timer.cleared = true;
		}) as unknown as typeof globalThis.clearTimeout,
		...overrides,
	};
	const pendingTimers = () => timers.filter((timer) => !timer.cleared);
	const fireTimer = (ms: number): void => {
		const timer = pendingTimers().find((t) => t.ms === ms);
		if (!timer) {
			throw new Error(`no pending timer for ${ms}ms`);
		}
		timer.cleared = true;
		timer.fn();
	};
	return { deps, order, stderrLines, exits, logged, timers, pendingTimers, fireTimer };
}

describe("exitCodeFor", () => {
	it("maps sources to exit codes", () => {
		expect(exitCodeFor("uncaughtException")).toBe(1);
		expect(exitCodeFor("unhandledRejection")).toBe(1);
		expect(exitCodeFor("main")).toBe(1);
		expect(exitCodeFor("SIGTERM")).toBe(143);
		expect(exitCodeFor("SIGHUP")).toBe(129);
	});
});

describe("createCrashGuard.handle", () => {
	it("runs restore → persist → log → flush → stderr → exit(1) in order", async () => {
		const { deps, order, stderrLines, exits, logged, pendingTimers } = makeDeps({ logPath: "/l/s.jsonl" });
		const guard = createCrashGuard(deps);
		await guard.handle("uncaughtException", new Error("boom"));
		expect(order).toEqual(["restoreTerminal", "persistSession", "log", "flush", "stderr", "exit"]);
		expect(exits).toEqual([1]);
		expect(stderrLines).toEqual(["z-agent crashed: boom (log: /l/s.jsonl)"]);
		expect(logged).toHaveLength(1);
		expect(logged[0]).toMatchObject({
			source: "uncaughtException",
			message: "boom",
			terminalRestored: true,
			sessionPersisted: true,
		});
		expect(typeof logged[0]?.stack).toBe("string");
		expect(pendingTimers()).toEqual([]);
	});

	it("prints the --debug hint when no log path exists", async () => {
		const { deps, stderrLines } = makeDeps();
		const guard = createCrashGuard(deps);
		await guard.handle("uncaughtException", new Error("boom"));
		expect(stderrLines).toEqual(["z-agent crashed: boom (rerun with --debug for a log)"]);
	});

	it("bounds persistSession by the deadline and records sessionPersisted:false", async () => {
		const { deps, order, exits, logged, fireTimer, pendingTimers } = makeDeps({
			persistSession: () => {
				order.push("persistSession");
				return new Promise<void>(() => {});
			},
			persistDeadlineMs: 2000,
		});
		const guard = createCrashGuard(deps);
		const done = guard.handle("uncaughtException", new Error("boom"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(order).toEqual(["restoreTerminal", "persistSession"]);
		fireTimer(2000);
		await done;
		expect(order).toEqual(["restoreTerminal", "persistSession", "log", "flush", "stderr", "exit"]);
		expect(logged[0]?.sessionPersisted).toBe(false);
		expect(exits).toEqual([1]);
		expect(pendingTimers()).toEqual([]);
	});

	it("still persists and exits when restoreTerminal throws", async () => {
		const { deps, order, exits, logged } = makeDeps({
			restoreTerminal: () => {
				order.push("restoreTerminal");
				throw new Error("tty broke");
			},
		});
		const guard = createCrashGuard(deps);
		await guard.handle("uncaughtException", new Error("boom"));
		expect(order).toEqual(["restoreTerminal", "persistSession", "log", "flush", "stderr", "exit"]);
		expect(logged[0]?.terminalRestored).toBe(false);
		expect(exits).toEqual([1]);
	});

	it("records sessionPersisted:false when persistSession rejects", async () => {
		const { deps, exits, logged } = makeDeps({
			persistSession: async () => {
				throw new Error("read-only fs");
			},
		});
		const guard = createCrashGuard(deps);
		await guard.handle("uncaughtException", new Error("boom"));
		expect(logged[0]?.sessionPersisted).toBe(false);
		expect(exits).toEqual([1]);
	});

	it("bounds flush by its deadline", async () => {
		const { deps, exits, fireTimer, pendingTimers } = makeDeps({
			flush: () => new Promise<void>(() => {}),
			flushDeadlineMs: 500,
		});
		const guard = createCrashGuard(deps);
		const done = guard.handle("uncaughtException", new Error("boom"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		fireTimer(500);
		await done;
		expect(exits).toEqual([1]);
		expect(pendingTimers()).toEqual([]);
	});

	it("a second fault while the first is in flight only writes stderr and exits", async () => {
		let releasePersist: (() => void) | undefined;
		const { deps, order, stderrLines, exits } = makeDeps({
			persistSession: () =>
				new Promise<void>((resolve) => {
					order.push("persistSession");
					releasePersist = resolve;
				}),
		});
		const guard = createCrashGuard(deps);
		const first = guard.handle("uncaughtException", new Error("first"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		await guard.handle("unhandledRejection", new Error("second"));
		expect(order.filter((step) => step === "persistSession")).toHaveLength(1);
		expect(stderrLines).toEqual(["z-agent crashed: second (rerun with --debug for a log)"]);
		expect(exits).toEqual([1]);
		releasePersist?.();
		await first;
		expect(exits).toEqual([1, 1]);
	});

	it("wraps non-Error rejection reasons into message text", async () => {
		const { deps, stderrLines, logged } = makeDeps();
		const guard = createCrashGuard(deps);
		await guard.handle("unhandledRejection", "plain string reason");
		expect(logged[0]?.message).toBe("plain string reason");
		expect(stderrLines[0]).toContain("plain string reason");
	});

	it("uses the source as message for bare signal faults", async () => {
		const { deps, stderrLines, exits, logged } = makeDeps();
		const guard = createCrashGuard(deps);
		await guard.handle("SIGTERM", undefined);
		expect(exits).toEqual([143]);
		expect(logged[0]).toMatchObject({ source: "SIGTERM", message: "SIGTERM" });
		expect(stderrLines[0]).toBe("z-agent crashed: SIGTERM (rerun with --debug for a log)");
	});
});

describe("createCrashGuard.install/uninstall", () => {
	it("registers and removes exactly the four listeners", async () => {
		const { deps, exits } = makeDeps();
		const guard = createCrashGuard(deps);
		const proc = new EventEmitter();
		guard.install(proc);
		for (const event of ["uncaughtException", "unhandledRejection", "SIGTERM", "SIGHUP"]) {
			expect(proc.listenerCount(event)).toBe(1);
		}
		proc.emit("SIGTERM");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(exits).toEqual([143]);
		guard.uninstall();
		for (const event of ["uncaughtException", "unhandledRejection", "SIGTERM", "SIGHUP"]) {
			expect(proc.listenerCount(event)).toBe(0);
		}
	});

	it("late rejections after uninstall do not re-trigger the guard", async () => {
		const { deps, stderrLines } = makeDeps();
		const guard = createCrashGuard(deps);
		const proc = new EventEmitter();
		guard.install(proc);
		guard.uninstall();
		proc.emit("unhandledRejection", new Error("late"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(stderrLines).toEqual([]);
	});

	it("an uncaughtException from process runs the full shutdown", async () => {
		const { deps, order, exits } = makeDeps({ logPath: "/l/s.jsonl" });
		const guard = createCrashGuard(deps);
		const proc = new EventEmitter();
		guard.install(proc);
		proc.emit("uncaughtException", new Error("fatal"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(order).toEqual(["restoreTerminal", "persistSession", "log", "flush", "stderr", "exit"]);
		expect(exits).toEqual([1]);
	});
});
