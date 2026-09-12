import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_STREAM_TIMEOUTS,
	linkAbort,
	StreamTimeoutError,
	withHeadersTimeout,
	withIdleTimeout,
} from "../src/timeouts.ts";

/** AsyncIterable whose next() calls are driven by push()/close(). */
function controllable<T>() {
	const pending: Array<(result: IteratorResult<T>) => void> = [];
	const buffered: T[] = [];
	let closed = false;
	const iterable: AsyncIterable<T> = {
		[Symbol.asyncIterator]() {
			return {
				next(): Promise<IteratorResult<T>> {
					if (buffered.length > 0) {
						return Promise.resolve({ value: buffered.shift() as T, done: false });
					}
					if (closed) {
						return Promise.resolve({ value: undefined, done: true });
					}
					return new Promise((resolve) => pending.push(resolve));
				},
				return(): Promise<IteratorResult<T>> {
					closed = true;
					while (pending.length > 0) {
						pending.shift()?.({ value: undefined, done: true });
					}
					return Promise.resolve({ value: undefined, done: true });
				},
			};
		},
	};
	return {
		iterable,
		push(value: T): void {
			const waiter = pending.shift();
			if (waiter) {
				waiter({ value, done: false });
			} else {
				buffered.push(value);
			}
		},
		close(): void {
			closed = true;
			while (pending.length > 0) {
				pending.shift()?.({ value: undefined, done: true });
			}
		},
	};
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of source) {
		out.push(item);
	}
	return out;
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("StreamTimeoutError / defaults", () => {
	it("encodes phase and message strings", () => {
		expect(new StreamTimeoutError("headers", 60_000).message).toBe(
			"Timed out waiting for response headers after 60s",
		);
		expect(new StreamTimeoutError("idle", 120_000).message).toBe("Stream idle for 120s");
		expect(DEFAULT_STREAM_TIMEOUTS).toEqual({ headersMs: 60_000, idleMs: 120_000 });
	});
});

describe("linkAbort", () => {
	it("propagates parent abort to the child signal", () => {
		const parent = new AbortController();
		const linked = linkAbort(parent.signal);
		expect(linked.signal.aborted).toBe(false);
		parent.abort();
		expect(linked.signal.aborted).toBe(true);
	});

	it("child abort does not touch the parent; dispose removes the listener", () => {
		const parent = new AbortController();
		const linked = linkAbort(parent.signal);
		linked.abort("mine");
		expect(linked.signal.aborted).toBe(true);
		expect(linked.signal.reason).toBe("mine");
		expect(parent.signal.aborted).toBe(false);

		const linked2 = linkAbort(parent.signal);
		linked2.dispose();
		parent.abort();
		expect(linked2.signal.aborted).toBe(false);
	});

	it("reflects an already-aborted parent", () => {
		const parent = new AbortController();
		parent.abort();
		expect(linkAbort(parent.signal).signal.aborted).toBe(true);
	});
});

describe("withHeadersTimeout", () => {
	it("rejects with StreamTimeoutError when run never resolves", async () => {
		vi.useFakeTimers();
		const promise = withHeadersTimeout(() => new Promise(() => {}), 1_000);
		const assertion = expect(promise).rejects.toMatchObject({
			name: "StreamTimeoutError",
			phase: "headers",
			ms: 1_000,
		});
		await vi.advanceTimersByTimeAsync(1_000);
		await assertion;
		expect(vi.getTimerCount()).toBe(0);
	});

	it("resolves with the run value and clears the timer", async () => {
		vi.useFakeTimers();
		const promise = withHeadersTimeout((signal) => {
			expect(signal.aborted).toBe(false);
			return Promise.resolve(42);
		}, 1_000);
		await expect(promise).resolves.toBe(42);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("rejects with AbortError on caller abort even when run ignores the signal", async () => {
		vi.useFakeTimers();
		const ac = new AbortController();
		const promise = withHeadersTimeout(() => new Promise(() => {}), 60_000, ac.signal);
		const assertion = expect(promise).rejects.toMatchObject({ name: "AbortError" });
		ac.abort();
		await assertion;
		expect(vi.getTimerCount()).toBe(0);
	});

	it("aborts the run signal on timeout", async () => {
		vi.useFakeTimers();
		let inner: AbortSignal | undefined;
		const promise = withHeadersTimeout((signal) => {
			inner = signal;
			return new Promise(() => {});
		}, 500);
		const assertion = expect(promise).rejects.toBeInstanceOf(StreamTimeoutError);
		await vi.advanceTimersByTimeAsync(500);
		await assertion;
		expect(inner?.aborted).toBe(true);
	});
});

describe("withIdleTimeout", () => {
	it("passes events through when gaps stay under the limit", async () => {
		vi.useFakeTimers();
		const src = controllable<number>();
		const seen = collect(withIdleTimeout(src.iterable, 100, vi.fn()));
		src.push(1);
		src.push(2);
		src.push(3);
		await vi.advanceTimersByTimeAsync(50);
		src.close();
		await vi.advanceTimersByTimeAsync(0);
		await expect(seen).resolves.toEqual([1, 2, 3]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("fires onTimeout once and terminates when the gap exceeds the limit", async () => {
		vi.useFakeTimers();
		const src = controllable<number>();
		const onTimeout = vi.fn();
		const seen = collect(withIdleTimeout(src.iterable, 100, onTimeout));
		src.push(1);
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(150);
		await vi.advanceTimersByTimeAsync(500);
		await expect(seen).resolves.toEqual([1]);
		expect(onTimeout).toHaveBeenCalledTimes(1);
		const error = onTimeout.mock.calls[0]?.[0] as StreamTimeoutError;
		expect(error).toBeInstanceOf(StreamTimeoutError);
		expect(error.phase).toBe("idle");
		expect(error.ms).toBe(100);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("ms = 0 disables the idle timer", async () => {
		vi.useFakeTimers();
		const src = controllable<number>();
		const onTimeout = vi.fn();
		const seen = collect(withIdleTimeout(src.iterable, 0, onTimeout));
		src.push(1);
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(10_000);
		src.close();
		await vi.advanceTimersByTimeAsync(0);
		await expect(seen).resolves.toEqual([1]);
		expect(onTimeout).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("propagates source errors without calling onTimeout", async () => {
		const src: AsyncIterable<number> = {
			async *[Symbol.asyncIterator]() {
				yield 1;
				throw new Error("source boom");
			},
		};
		const onTimeout = vi.fn();
		await expect(collect(withIdleTimeout(src, 1_000, onTimeout))).rejects.toThrow("source boom");
		expect(onTimeout).not.toHaveBeenCalled();
	});
});
