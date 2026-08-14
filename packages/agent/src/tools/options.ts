/**
 * Shared options for coding tools exported from @z-agent/agent.
 */

export interface CodingToolsOptions {
	/**
	 * Jail root for path checks. Default: the tool `cwd`.
	 * `false` disables the jail (`--no-jail`).
	 */
	jailRoot?: string | false;
}

export function resolveJailRoot(cwd: string, jailRoot?: string | false): string | false {
	if (jailRoot === false) {
		return false;
	}
	return jailRoot ?? cwd;
}

export function abortedError(): Error {
	return new Error("Operation aborted");
}

export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw abortedError();
	}
}
