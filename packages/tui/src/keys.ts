export type Key =
	| { type: "char"; value: string }
	| { type: "paste"; value: string }
	| { type: "tab" }
	| { type: "enter" }
	| { type: "backspace" }
	| { type: "delete" }
	| { type: "escape" }
	| { type: "home" }
	| { type: "end" }
	| { type: "pageUp" }
	| { type: "pageDown" }
	| { type: "newline" }
	| { type: "ctrl"; value: string }
	| { type: "up" }
	| { type: "down" }
	| { type: "left" }
	| { type: "right" };

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const ESCAPE_SEQUENCES = [
	"\x1b[13;2u",
	"\x1b[27;2;13~",
	"\x1b[3~",
	"\x1b[5~",
	"\x1b[6~",
	"\x1b[A",
	"\x1b[B",
	"\x1b[C",
	"\x1b[D",
	"\x1b[H",
	"\x1b[F",
	"\x1bOH",
	"\x1bOF",
	"\x1b\r",
	"\x1b\n",
] as const;

/**
 * Parse a stdin chunk into a key. Incomplete escape sequences return undefined.
 */
export function parseKey(input: string): Key | undefined {
	if (input.startsWith(PASTE_START) && input.endsWith(PASTE_END)) {
		return { type: "paste", value: input.slice(PASTE_START.length, -PASTE_END.length) };
	}
	if (input === "\r" || input === "\n") {
		return { type: "enter" };
	}
	if (input === "\t") {
		return { type: "tab" };
	}
	if (input === "\x1b\r" || input === "\x1b\n" || input === "\x1b[13;2u" || input === "\x1b[27;2;13~") {
		return { type: "newline" };
	}
	if (input === "\x7f" || input === "\b") {
		return { type: "backspace" };
	}
	if (input === "\x1b") {
		return { type: "escape" };
	}
	if (input === "\x1b[A") {
		return { type: "up" };
	}
	if (input === "\x1b[B") {
		return { type: "down" };
	}
	if (input === "\x1b[C") {
		return { type: "right" };
	}
	if (input === "\x1b[D") {
		return { type: "left" };
	}
	if (input === "\x1b[3~") {
		return { type: "delete" };
	}
	if (input === "\x1b[5~") {
		return { type: "pageUp" };
	}
	if (input === "\x1b[6~") {
		return { type: "pageDown" };
	}
	if (input === "\x1b[H" || input === "\x1bOH") {
		return { type: "home" };
	}
	if (input === "\x1b[F" || input === "\x1bOF") {
		return { type: "end" };
	}
	if (input.length === 1 && input.charCodeAt(0) < 32) {
		const letter = String.fromCharCode(input.charCodeAt(0) + 64).toLowerCase();
		return { type: "ctrl", value: letter };
	}
	if (input.length > 0 && !input.startsWith("\x1b")) {
		return { type: "char", value: input };
	}
	return undefined;
}

/** Parse every complete key in a stdin chunk and retain an incomplete paste. */
export function parseInputChunk(input: string): { keys: Key[]; remainder: string } {
	const keys: Key[] = [];
	let offset = 0;
	while (offset < input.length) {
		const next = takeNextKey(input.slice(offset));
		if (!next) {
			break;
		}
		keys.push(next.key);
		offset += next.length;
	}
	return { keys, remainder: input.slice(offset) };
}

function takeNextKey(input: string): { key: Key; length: number } | undefined {
	if (input.startsWith(PASTE_START)) {
		const end = input.indexOf(PASTE_END, PASTE_START.length);
		if (end < 0) {
			return undefined;
		}
		const length = end + PASTE_END.length;
		return { key: { type: "paste", value: input.slice(PASTE_START.length, end) }, length };
	}
	if (input.startsWith("\x1b")) {
		for (const sequence of ESCAPE_SEQUENCES) {
			if (input.startsWith(sequence)) {
				const key = parseKey(sequence);
				if (key) {
					return { key, length: sequence.length };
				}
			}
		}
		if (
			input.length > 1 &&
			(PASTE_START.startsWith(input) || ESCAPE_SEQUENCES.some((sequence) => sequence.startsWith(input)))
		) {
			return undefined;
		}
		return { key: { type: "escape" }, length: 1 };
	}
	const first = input.charCodeAt(0);
	if (first < 32 || first === 127) {
		const key = parseKey(input[0] ?? "");
		return key ? { key, length: 1 } : undefined;
	}
	let length = 1;
	while (length < input.length) {
		const code = input.charCodeAt(length);
		if (input[length] === "\x1b" || code < 32 || code === 127) {
			break;
		}
		length += 1;
	}
	const key = parseKey(input.slice(0, length));
	return key ? { key, length } : undefined;
}
