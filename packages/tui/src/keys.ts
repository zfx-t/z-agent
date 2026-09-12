/** Decoded SGR mouse report. Coordinates are 0-indexed terminal cells. */
export interface MouseEventInfo {
	kind: "down" | "up" | "drag";
	button: "left" | "middle" | "right";
	col: number;
	row: number;
	shift: boolean;
	alt: boolean;
	ctrl: boolean;
}

export type Key =
	| { type: "char"; value: string }
	| { type: "paste"; value: string }
	| { type: "tab" }
	| { type: "shiftTab" }
	| { type: "enter" }
	| { type: "ctrlEnter" }
	| { type: "backspace" }
	| { type: "delete" }
	| { type: "escape" }
	| { type: "home" }
	| { type: "end" }
	| { type: "pageUp" }
	| { type: "pageDown" }
	| { type: "newline" }
	| { type: "ctrl"; value: string }
	| { type: "wordLeft" }
	| { type: "wordRight" }
	| { type: "deleteWordForward" }
	| { type: "deleteWordBack" }
	| { type: "selectLeft" }
	| { type: "selectRight" }
	| { type: "selectUp" }
	| { type: "selectDown" }
	| { type: "selectWordLeft" }
	| { type: "selectWordRight" }
	| { type: "selectHome" }
	| { type: "selectEnd" }
	| { type: "report" }
	| { type: "mouse"; event: MouseEventInfo }
	| { type: "wheelUp"; col?: number; row?: number }
	| { type: "wheelDown"; col?: number; row?: number }
	| { type: "up" }
	| { type: "down" }
	| { type: "left" }
	| { type: "right" };

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const ESC = "\u001b";
const DSR_REPORT = new RegExp(`^${ESC}\\[\\d+;\\d+R`);
/** SGR mouse report: ESC [ < Cb ; Cx ; Cy (M press | m release). */
const SGR_MOUSE = new RegExp(`^${ESC}\\[<(\\d+);(\\d+);(\\d+)([Mm])`);
/** Modified arrow/home/end: ESC [ 1 ; <mod> <final>. Modifier = 1 + bitmask (1 shift, 2 alt, 4 ctrl). */
const MOD_ARROW = new RegExp(`^${ESC}\\[1;(\\d+)([ABCDFH])`);
/** Modified tilde keys: ESC [ <key> ; <mod> ~ (delete/pgup/pgdn/home/end variants). */
const MOD_TILDE = new RegExp(`^${ESC}\\[(\\d+);(\\d+)~`);
/** Kitty keyboard protocol: ESC [ <codepoint> [; <mod>] u. */
const MOD_U = new RegExp(`^${ESC}\\[(\\d+)(?:;(\\d+))?u`);
/** Incomplete CSI of any shape: only parameter digits, `<`, and `;` so far. */
const CSI_PARTIAL = new RegExp(`^${ESC}\\[[\\d;<]*$`);
const ESCAPE_SEQUENCES = [
	"\x1b[13;2u",
	"\x1b[27;2;13~",
	"\x1b[3;5~",
	"\x1b[3~",
	"\x1b[5~",
	"\x1b[6~",
	"\x1b[Z",
	"\x1b[1;5A",
	"\x1b[1;5B",
	"\x1b[1;5C",
	"\x1b[1;5D",
	"\x1b[1;3C",
	"\x1b[1;3D",
	"\x1b[A",
	"\x1b[B",
	"\x1b[C",
	"\x1b[D",
	"\x1b[H",
	"\x1b[F",
	"\x1bOA",
	"\x1bOB",
	"\x1bOC",
	"\x1bOD",
	"\x1bOH",
	"\x1bOF",
	"\x1b\x7f",
	"\x1b\r",
	"\x1b\n",
] as const;

/**
 * Map a CSI modifier parameter (1 + bitmask: 1 shift, 2 alt, 4 ctrl) onto the
 * semantic key for an arrow or home/end final.
 */
function modifiedArrow(mod: number, final: string): Key | undefined {
	const shift = (mod - 1) & 1;
	const alt = (mod - 1) & 2;
	const ctrl = (mod - 1) & 4;
	switch (final) {
		case "A":
			return { type: shift ? "selectUp" : "up" };
		case "B":
			return { type: shift ? "selectDown" : "down" };
		case "C":
			if (shift && (alt || ctrl)) {
				return { type: "selectWordRight" };
			}
			if (shift) {
				return { type: "selectRight" };
			}
			return { type: alt || ctrl ? "wordRight" : "right" };
		case "D":
			if (shift && (alt || ctrl)) {
				return { type: "selectWordLeft" };
			}
			if (shift) {
				return { type: "selectLeft" };
			}
			return { type: alt || ctrl ? "wordLeft" : "left" };
		case "H":
			return { type: shift ? "selectHome" : "home" };
		case "F":
			return { type: shift ? "selectEnd" : "end" };
	}
	return undefined;
}

/** Map a CSI ~ key number + modifier (e.g. 3;5~ ctrl+delete, 27;5;13~). */
function modifiedTilde(keyNum: number, mod: number): Key | undefined {
	const shift = (mod - 1) & 1;
	const ctrl = (mod - 1) & 4;
	switch (keyNum) {
		case 1:
		case 7:
			return { type: shift ? "selectHome" : "home" };
		case 4:
		case 8:
			return { type: shift ? "selectEnd" : "end" };
		case 3:
			return { type: ctrl ? "deleteWordForward" : "delete" };
		case 5:
			return { type: "pageUp" };
		case 6:
			return { type: "pageDown" };
	}
	return undefined;
}

/** xterm modifyOtherKeys: ESC [ 27 ; <mod> ; <codepoint> ~ — enter family only. */
const MOD_OTHER = new RegExp(`^${ESC}\\[27;(\\d+);(\\d+)~`);

function enterForMod(mod: number): Key {
	const shift = (mod - 1) & 1;
	const alt = (mod - 1) & 2;
	const ctrl = (mod - 1) & 4;
	if (ctrl) {
		return { type: "ctrlEnter" };
	}
	if (shift || alt) {
		return { type: "newline" };
	}
	return { type: "enter" };
}

function modifiedU(codepoint: number, mod: number): Key | undefined {
	if (codepoint === 13) {
		return enterForMod(mod);
	}
	// Other CSI-u codepoints (modified letters etc.) are swallowed, never typed.
	return { type: "report" };
}

/** Decode an SGR mouse report: wheel events carry coords; buttons decode press/release/drag. */
function decodeMouse(match: RegExpExecArray): Key {
	const cb = Number(match[1]);
	const col = Math.max(0, Number(match[2]) - 1);
	const row = Math.max(0, Number(match[3]) - 1);
	const press = match[4] === "M";
	if ((cb & 64) !== 0) {
		// Wheel: report only the press edge; SGR also emits a release tick.
		if (!press) {
			return { type: "report" };
		}
		return { type: (cb & 1) === 1 ? "wheelDown" : "wheelUp", col, row };
	}
	const buttonBits = cb & 3;
	if (buttonBits === 3) {
		// Legacy release / pure motion marker.
		return { type: "report" };
	}
	const button = buttonBits === 1 ? "middle" : buttonBits === 2 ? "right" : "left";
	const kind = !press ? "up" : (cb & 32) !== 0 ? "drag" : "down";
	return {
		type: "mouse",
		event: {
			kind,
			button,
			col,
			row,
			shift: (cb & 4) !== 0,
			alt: (cb & 8) !== 0,
			ctrl: (cb & 16) !== 0,
		},
	};
}

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
	if (input === "\x1b[Z") {
		return { type: "shiftTab" };
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
	if (input === "\x1b[A" || input === "\x1bOA") {
		return { type: "up" };
	}
	if (input === "\x1b[B" || input === "\x1bOB") {
		return { type: "down" };
	}
	if (input === "\x1b[C" || input === "\x1bOC") {
		return { type: "right" };
	}
	if (input === "\x1b[D" || input === "\x1bOD") {
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
	if (input === "\x1b[1;5D" || input === "\x1b[1;3D") {
		return { type: "wordLeft" };
	}
	if (input === "\x1b[1;5C" || input === "\x1b[1;3C") {
		return { type: "wordRight" };
	}
	if (input === "\x1b[3;5~") {
		return { type: "deleteWordForward" };
	}
	if (input === "\x1b\x7f") {
		return { type: "deleteWordBack" };
	}
	if (input === "\x1b[1;5A") {
		return { type: "up" };
	}
	if (input === "\x1b[1;5B") {
		return { type: "down" };
	}
	const mouse = SGR_MOUSE.exec(input);
	if (mouse) {
		return decodeMouse(mouse);
	}
	const arrow = MOD_ARROW.exec(input);
	if (arrow) {
		return modifiedArrow(Number(arrow[1]), arrow[2] ?? "");
	}
	const other = MOD_OTHER.exec(input);
	if (other) {
		if (Number(other[2]) === 13) {
			return enterForMod(Number(other[1]));
		}
		return { type: "report" };
	}
	const tilde = MOD_TILDE.exec(input);
	if (tilde) {
		return modifiedTilde(Number(tilde[1]), Number(tilde[2]));
	}
	const kitty = MOD_U.exec(input);
	if (kitty) {
		return modifiedU(Number(kitty[1]), Number(kitty[2] ?? "1"));
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
		// Terminal device-status report (cursor position); consume, never emit as text.
		const dsr = DSR_REPORT.exec(input);
		if (dsr) {
			return { key: { type: "report" }, length: dsr[0].length };
		}
		const mouse = SGR_MOUSE.exec(input);
		if (mouse) {
			return { key: decodeMouse(mouse), length: mouse[0].length };
		}
		const arrow = MOD_ARROW.exec(input);
		if (arrow) {
			const key = modifiedArrow(Number(arrow[1]), arrow[2] ?? "");
			if (key) {
				return { key, length: arrow[0].length };
			}
		}
		const other = MOD_OTHER.exec(input);
		if (other) {
			const key = Number(other[2]) === 13 ? enterForMod(Number(other[1])) : { type: "report" as const };
			return { key, length: other[0].length };
		}
		const tilde = MOD_TILDE.exec(input);
		if (tilde) {
			const key = modifiedTilde(Number(tilde[1]), Number(tilde[2])) ?? { type: "report" as const };
			return { key, length: tilde[0].length };
		}
		const kitty = MOD_U.exec(input);
		if (kitty) {
			const key = modifiedU(Number(kitty[1]), Number(kitty[2] ?? "1")) ?? { type: "report" as const };
			return { key, length: kitty[0].length };
		}
		if (CSI_PARTIAL.test(input)) {
			return undefined;
		}
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
