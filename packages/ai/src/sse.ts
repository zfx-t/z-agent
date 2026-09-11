/**
 * Shared SSE parser for provider streams.
 *
 * Parses a byte stream of `data:` lines into JSON events. Multi-line `data:`
 * payloads are joined with "\n". `event:` lines and `:` comments are ignored;
 * `[DONE]` is skipped. Aborts unblock a pending read().
 */
export async function* parseSseJson<T>(
	body: ReadableStream<Uint8Array> | null,
	signal?: AbortSignal,
): AsyncGenerator<T> {
	if (!body) {
		throw new Error("Response body is empty");
	}

	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let dataLines: string[] = [];

	const flush = (): T | undefined => {
		if (dataLines.length === 0) return undefined;
		const raw = dataLines.join("\n").trim();
		dataLines = [];
		if (!raw || raw === "[DONE]") return undefined;
		return JSON.parse(raw) as T;
	};

	// Unblock a pending read() when AbortSignal fires (custom fetch may ignore body signal).
	const onAbort = (): void => {
		void reader.cancel().catch(() => {});
	};
	if (signal) {
		if (signal.aborted) {
			await reader.cancel().catch(() => {});
			throw new DOMException("The operation was aborted.", "AbortError");
		}
		signal.addEventListener("abort", onAbort, { once: true });
	}

	try {
		while (true) {
			if (signal?.aborted) {
				throw new DOMException("The operation was aborted.", "AbortError");
			}
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			while (true) {
				const newline = buffer.indexOf("\n");
				if (newline === -1) break;
				let line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);

				if (line === "") {
					const event = flush();
					if (event) yield event;
					continue;
				}
				if (line.startsWith(":") || line.startsWith("event:")) {
					continue;
				}
				if (line.startsWith("data:")) {
					dataLines.push(line.slice(5).replace(/^\s/, ""));
				}
			}
		}

		buffer += decoder.decode();
		if (buffer.length > 0) {
			const trailing = buffer.replace(/\r$/, "");
			if (trailing.startsWith("data:")) {
				dataLines.push(trailing.slice(5).replace(/^\s/, ""));
			}
		}
		const last = flush();
		if (last) yield last;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		// Cancel so non-abort error paths do not leave the connection draining until GC.
		try {
			await reader.cancel();
		} catch {
			// already cancelled / closed
		}
		try {
			reader.releaseLock();
		} catch {
			// lock released by cancel()
		}
	}
}
