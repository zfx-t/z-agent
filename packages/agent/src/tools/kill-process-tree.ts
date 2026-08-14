/**
 * Kill a process and its children. win32: taskkill /F /T; POSIX: kill(-pid).
 */

import { spawnSync } from "node:child_process";

export type ProcessKiller = (pid: number) => void;

export function killProcessTree(pid: number, runner: ProcessKiller = defaultKillProcessTree): void {
	runner(pid);
}

export function defaultKillProcessTree(pid: number): void {
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true, stdio: "ignore" });
		return;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
}

export function win32TaskkillArgs(pid: number): string[] {
	return ["/F", "/T", "/PID", String(pid)];
}
