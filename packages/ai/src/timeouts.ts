/**
 * Stream timeout primitives (ADR-0028).
 *
 * Two independent timers guard a provider stream:
 * - headers timeout: fetch start → response headers received
 * - idle timeout: max gap between two SSE events (starts after headers)
 *
 * `0` disables a timer. Timeouts abort an internal child signal linked to the
 * caller signal, so caller abort always wins and timeout-vs-abort stays
 * distinguishable via isAbortError(error, callerSignal).
 */

export interface StreamTimeouts {
	headersMs: number;
	idleMs: number;
}

export const DEFAULT_STREAM_TIMEOUTS: StreamTimeouts = {
	headersMs: 60_000,
	idleMs: 120_000,
};

export class StreamTimeoutError extends Error {
	readonly phase: "headers" | "idle";
	readonly ms: number;

	constructor(phase: "headers" | "idle", ms: number) {
		super(
			phase === "headers"
				? `Timed out waiting for response headers after ${ms / 1000}s`
				: `Stream idle for ${ms / 1000}s`,
		);
		this.name = "StreamTimeoutError";
		this.phase = phase;
		this.ms = ms;
	}
}

function abortError(): DOMException {
	return new DOMException("The operation was aborted.", "AbortError");
}

/** Child controller aborted by the parent or by `abort(reason)`. */
export function linkAbort(parent?: AbortSignal): {
	signal: AbortSignal;
	abort: (reason: unknown) => void;
	dispose: () => void;
} {
	const controller = new AbortController();
	const onAbort = () => controller.abort(parent?.reason);
	if (parent?.aborted) {
		controller.abort(parent.reason);
	} else {
		parent?.addEventListener("abort", onAbort, { once: true });
	}
	return {
		signal: controller.signal,
		abort: (reason: unknown) => controller.abort(reason),
		dispose: () => parent?.removeEventListener("abort", onAbort),
	};
}

/**
 * Run `run` with a child signal that aborts on caller abort or after `ms`.
 * Rejects with StreamTimeoutError on timeout even when `run` ignores the
 * signal; rejects with the abort reason on caller abort. `ms <= 0` disables
 * the timer (caller abort still propagates).
 */
export async function withHeadersTimeout<T>(
	run: (signal: AbortSignal) => Promise<T>,
	ms: number,
	parent?: AbortSignal,
): Promise<T> {
	const linked = linkAbort(parent);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			run(linked.signal),
			new Promise<never>((_resolve, reject) => {
				if (linked.signal.aborted) {
					reject(linked.signal.reason ?? abortError());
					return;
				}
				linked.signal.addEventListener("abort", () => reject(linked.signal.reason ?? abortError()), { once: true });
				if (ms > 0) {
					timer = setTimeout(() => {
						const error = new StreamTimeoutError("headers", ms);
						linked.abort(error);
						reject(error);
					}, ms);
				}
			}),
		]);
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
		linked.dispose();
	}
}

/**
 * Wrap an async iterable with a per-event idle timer. When no item arrives
 * within `ms`, `onTimeout` fires once and the generator terminates. `ms <= 0`
 * disables the timer. The timer resets after every yielded item.
 */
export async function* withIdleTimeout<T>(
	source: AsyncIterable<T>,
	ms: number,
	onTimeout: (error: StreamTimeoutError) => void,
): AsyncGenerator<T> {
	const iterator = source[Symbol.asyncIterator]();
	let finished = false;
	try {
		while (true) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			let result: IteratorResult<T>;
			try {
				result = await Promise.race([
					iterator.next(),
					new Promise<never>((_resolve, reject) => {
						if (ms > 0) {
							timer = setTimeout(() => reject(new StreamTimeoutError("idle", ms)), ms);
						}
					}),
				]);
			} catch (error) {
				if (error instanceof StreamTimeoutError) {
					onTimeout(error);
					return;
				}
				throw error;
			} finally {
				if (timer !== undefined) {
					clearTimeout(timer);
				}
			}
			if (result.done) {
				finished = true;
				return;
			}
			yield result.value;
		}
	} finally {
		if (!finished) {
			try {
				await iterator.return?.();
			} catch {
				// source cleanup failure must not mask the timeout
			}
		}
	}
}
