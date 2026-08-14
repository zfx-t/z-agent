import type { AssistantMessage, AssistantMessageEvent } from "./types.ts";

/**
 * Push-based async iterable stream.
 *
 * Producers call {@link push} / {@link end}; consumers iterate with `for await`
 * or await {@link result} for the final value extracted from a completing event.
 *
 * **Single consumer:** only one concurrent `for await` / async iterator is supported.
 * Multiple iterators share the same queue and waiters and will load-balance (or hang)
 * rather than each receiving a full copy of events.
 *
 * **Terminal contract:** producers must either push a completing event (`isComplete`)
 * or call `end(result)`. Bare `end()` without a prior completing push rejects
 * {@link result} so callers never hang indefinitely.
 */
export class EventStream<T, R = T> implements AsyncIterable<T> {
	private queue: T[] = [];
	private waiting: ((value: IteratorResult<T>) => void)[] = [];
	private done = false;
	private finalResultPromise: Promise<R>;
	private resolveFinalResult: (result: R) => void = () => {};
	private rejectFinalResult: (error: Error) => void = () => {};
	private finalResolved = false;
	private isComplete: (event: T) => boolean;
	private extractResult: (event: T) => R;

	constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
		this.isComplete = isComplete;
		this.extractResult = extractResult;
		this.finalResultPromise = new Promise<R>((resolve, reject) => {
			this.resolveFinalResult = resolve;
			this.rejectFinalResult = reject;
		});
		// Avoid unhandled rejection if nobody awaits result() and bare end() rejects.
		this.finalResultPromise.catch(() => {});
	}

	push(event: T): void {
		if (this.done) return;

		if (this.isComplete(event)) {
			this.done = true;
			if (!this.finalResolved) {
				this.finalResolved = true;
				this.resolveFinalResult(this.extractResult(event));
			}
		}

		const waiter = this.waiting.shift();
		if (waiter) {
			waiter({ value: event, done: false });
		} else {
			this.queue.push(event);
		}
	}

	/**
	 * Mark the stream finished.
	 *
	 * - With `result`: resolves {@link result} when no completing event was pushed.
	 * - Without `result` and no prior completing push: rejects {@link result}
	 *   with an Error so consumers never hang.
	 */
	end(result?: R): void {
		this.done = true;
		if (!this.finalResolved) {
			this.finalResolved = true;
			if (result !== undefined) {
				this.resolveFinalResult(result);
			} else {
				this.rejectFinalResult(new Error("EventStream ended without a final result"));
			}
		}
		while (this.waiting.length > 0) {
			const waiter = this.waiting.shift();
			if (waiter) {
				waiter({ value: undefined as unknown as T, done: true });
			}
		}
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.queue.length > 0) {
				const next = this.queue.shift();
				if (next !== undefined) {
					yield next;
				}
			} else if (this.done) {
				return;
			} else {
				const result = await new Promise<IteratorResult<T>>((resolve) => {
					this.waiting.push(resolve);
				});
				if (result.done) return;
				yield result.value;
			}
		}
	}

	/**
	 * Resolves when a completing event is pushed or {@link end} is called with a result.
	 * Rejects if the stream is ended without either.
	 */
	result(): Promise<R> {
		return this.finalResultPromise;
	}
}

/**
 * Typed event stream for assistant turns.
 * Completes on `done` or `error` events; {@link result} is the final AssistantMessage.
 */
export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") {
					return event.message;
				}
				if (event.type === "error") {
					return event.error;
				}
				throw new Error("Unexpected event type for final result");
			},
		);
	}
}

export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	return new AssistantMessageEventStream();
}
