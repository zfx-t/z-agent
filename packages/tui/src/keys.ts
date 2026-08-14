export type Key =
	| { type: "char"; value: string }
	| { type: "enter" }
	| { type: "backspace" }
	| { type: "escape" }
	| { type: "ctrl"; value: string }
	| { type: "up" }
	| { type: "down" }
	| { type: "left" }
	| { type: "right" };

/**
 * Parse a stdin chunk into a key. Incomplete escape sequences return undefined.
 */
export function parseKey(input: string): Key | undefined {
	if (input === "\r" || input === "\n") {
		return { type: "enter" };
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
	if (input.length === 1 && input.charCodeAt(0) < 32) {
		const letter = String.fromCharCode(input.charCodeAt(0) + 64).toLowerCase();
		return { type: "ctrl", value: letter };
	}
	if (input.length > 0 && !input.startsWith("\x1b")) {
		return { type: "char", value: input };
	}
	return undefined;
}
