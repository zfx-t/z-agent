export type Tone = "accent" | "dim" | "error" | "info" | "muted" | "success" | "strong" | "warning";

const ANSI: Record<Tone, string> = {
	accent: "\x1b[38;5;45m",
	dim: "\x1b[2m",
	error: "\x1b[38;5;203m",
	info: "\x1b[38;5;111m",
	muted: "\x1b[38;5;245m",
	success: "\x1b[38;5;78m",
	strong: "\x1b[1m",
	warning: "\x1b[38;5;221m",
};
const RESET = "\x1b[0m";
const ESC = "\u001b";
export const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");

export function color(enabled: boolean, tone: Tone, text: string): string {
	return enabled ? `${ANSI[tone]}${text}${RESET}` : text;
}

export function clean(text: string): string {
	return removeControls(text.replace(ANSI_PATTERN, "")).replace(/\t/g, "  ");
}

function removeControls(text: string): string {
	return Array.from(text)
		.filter((char) => {
			const code = char.codePointAt(0) ?? 0;
			return code === 0x0a || code === 0x09 || (code >= 0x20 && code !== 0x7f);
		})
		.join("");
}

export function wrap(text: string, width: number): string[] {
	const parts = text.split("\n");
	const lines: string[] = [];
	for (const part of parts) {
		if (part.length === 0) {
			lines.push("");
			continue;
		}
		let current = "";
		let currentWidth = 0;
		for (const char of Array.from(part)) {
			const charWidth = cellWidth(char);
			if (currentWidth > 0 && currentWidth + charWidth > width) {
				lines.push(current);
				current = "";
				currentWidth = 0;
			}
			current += char;
			currentWidth += charWidth;
		}
		lines.push(current);
	}
	return lines.length > 0 ? lines : [""];
}

export function clip(text: string, width: number): string {
	if (visibleWidth(text) <= width) {
		return text;
	}
	const plain = clean(text);
	if (width <= 3) {
		return wrap(plain, Math.max(1, width))[0] ?? "";
	}
	const clipped = wrap(plain, Math.max(1, width - 3))[0] ?? "";
	return `${clipped}...`;
}

export function visibleWidth(text: string): number {
	return Array.from(text.replace(ANSI_PATTERN, "")).reduce((total, char) => total + cellWidth(char), 0);
}

/**
 * East-Asian Ambiguous code-point ranges (Unicode TR11 "A" category, common
 * subset). Terminals in CJK contexts often render these as 2 cells; counting
 * them as 1 makes painted lines overflow, wrap, and desync the whole frame.
 */
const AMBIGUOUS_RANGES: ReadonlyArray<readonly [number, number]> = [
	[0x00a1, 0x00a1],
	[0x00a4, 0x00a4],
	[0x00a7, 0x00a8],
	[0x00aa, 0x00aa],
	[0x00ad, 0x00ae],
	[0x00b0, 0x00b4],
	[0x00b6, 0x00ba],
	[0x00bc, 0x00bf],
	[0x00c6, 0x00c6],
	[0x00d0, 0x00d0],
	[0x00d7, 0x00d8],
	[0x00de, 0x00e1],
	[0x00e6, 0x00e6],
	[0x00e8, 0x00ea],
	[0x00ec, 0x00ed],
	[0x00f0, 0x00f0],
	[0x00f2, 0x00f3],
	[0x00f7, 0x00fa],
	[0x00fc, 0x00fc],
	[0x00fe, 0x00fe],
	[0x0101, 0x0101],
	[0x0111, 0x0111],
	[0x0113, 0x0113],
	[0x011b, 0x011b],
	[0x0126, 0x0127],
	[0x012b, 0x012b],
	[0x0131, 0x0133],
	[0x0138, 0x0138],
	[0x013f, 0x0142],
	[0x0144, 0x0144],
	[0x0148, 0x014b],
	[0x014d, 0x014d],
	[0x0152, 0x0153],
	[0x0166, 0x0167],
	[0x016b, 0x016b],
	[0x01ce, 0x01ce],
	[0x01d0, 0x01d0],
	[0x01d2, 0x01d2],
	[0x01d4, 0x01d4],
	[0x01d6, 0x01d6],
	[0x01d8, 0x01d8],
	[0x01da, 0x01da],
	[0x01dc, 0x01dc],
	[0x0251, 0x0251],
	[0x0261, 0x0261],
	[0x02c4, 0x02c4],
	[0x02c7, 0x02c7],
	[0x02c9, 0x02cb],
	[0x02cd, 0x02cd],
	[0x02d0, 0x02d0],
	[0x02d8, 0x02db],
	[0x02dd, 0x02dd],
	[0x02df, 0x02df],
	[0x0391, 0x03a1],
	[0x03a3, 0x03a9],
	[0x03b1, 0x03c1],
	[0x03c3, 0x03c9],
	[0x0401, 0x0401],
	[0x0410, 0x044f],
	[0x0451, 0x0451],
	[0x2010, 0x2010],
	[0x2013, 0x2016],
	[0x2018, 0x2019],
	[0x201c, 0x201d],
	[0x2020, 0x2022],
	[0x2024, 0x2027],
	[0x2030, 0x2030],
	[0x2032, 0x2033],
	[0x2035, 0x2035],
	[0x203b, 0x203b],
	[0x203e, 0x203e],
	[0x2074, 0x2074],
	[0x207f, 0x207f],
	[0x2081, 0x2084],
	[0x20ac, 0x20ac],
	[0x2103, 0x2103],
	[0x2105, 0x2105],
	[0x2109, 0x2109],
	[0x2113, 0x2113],
	[0x2116, 0x2116],
	[0x2121, 0x2122],
	[0x2126, 0x2126],
	[0x212b, 0x212b],
	[0x2153, 0x2154],
	[0x215b, 0x215e],
	[0x2160, 0x216b],
	[0x2170, 0x2179],
	[0x2190, 0x2199],
	[0x21b8, 0x21b9],
	[0x21d2, 0x21d2],
	[0x21d4, 0x21d4],
	[0x21e7, 0x21e7],
	[0x2200, 0x2200],
	[0x2202, 0x2203],
	[0x2207, 0x2208],
	[0x220b, 0x220b],
	[0x220f, 0x220f],
	[0x2211, 0x2211],
	[0x2215, 0x2215],
	[0x221a, 0x221a],
	[0x221d, 0x2220],
	[0x2223, 0x2223],
	[0x2225, 0x2225],
	[0x2227, 0x222c],
	[0x222e, 0x222e],
	[0x2234, 0x2237],
	[0x223c, 0x223d],
	[0x2248, 0x2248],
	[0x224c, 0x224c],
	[0x2252, 0x2252],
	[0x2260, 0x2261],
	[0x2264, 0x2267],
	[0x226a, 0x226b],
	[0x226e, 0x226f],
	[0x2282, 0x2283],
	[0x2286, 0x2287],
	[0x2295, 0x2295],
	[0x2299, 0x2299],
	[0x22a5, 0x22a5],
	[0x22bf, 0x22bf],
	[0x2312, 0x2312],
	[0x2460, 0x24e9],
	[0x24eb, 0x254b],
	[0x2550, 0x2573],
	[0x2580, 0x258f],
	[0x2592, 0x2595],
	[0x25a0, 0x25a1],
	[0x25a3, 0x25a9],
	[0x25b2, 0x25b3],
	[0x25b6, 0x25b7],
	[0x25bc, 0x25bd],
	[0x25c0, 0x25c1],
	[0x25c6, 0x25c8],
	[0x25cb, 0x25cb],
	[0x25ce, 0x25d1],
	[0x25e2, 0x25e5],
	[0x25ef, 0x25ef],
	[0x2605, 0x2606],
	[0x2609, 0x2609],
	[0x260e, 0x260f],
	[0x261c, 0x261c],
	[0x261e, 0x261f],
	[0x2640, 0x2640],
	[0x2642, 0x2642],
	[0x2660, 0x2661],
	[0x2663, 0x2665],
	[0x2667, 0x266a],
	[0x266c, 0x266d],
	[0x266f, 0x266f],
	[0x273d, 0x273d],
	[0x2776, 0x277f],
	[0xe000, 0xf8ff],
	[0xfffd, 0xfffd],
	[0xffe0, 0xffe6],
];

let ambiguousWideForced: boolean | undefined;
let ambiguousWideProbed: boolean | undefined;
let ambiguousWideDetected: boolean | undefined;

function detectAmbiguousWide(): boolean {
	const override = process.env.Z_AGENT_AMBIGUOUS;
	if (override === "double" || override === "2") {
		return true;
	}
	if (override === "single" || override === "1") {
		return false;
	}
	if (/^(1|true|on)$/iu.test(process.env.RUNEWIDTH_EASTASIAN ?? "")) {
		return true;
	}
	if (ambiguousWideProbed !== undefined) {
		return ambiguousWideProbed;
	}
	const locale = `${process.env.LC_ALL ?? ""} ${process.env.LC_CTYPE ?? ""} ${process.env.LANG ?? ""}`;
	return /zh_|ja_|ko_|_CN|_TW|_HK|_JP|_KR|CJK|big5|gbk|gb18030|euc-?jp|euc-?kr/iu.test(locale);
}

/**
 * Whether East-Asian Ambiguous code points count as 2 cells. Sources in order:
 * `setAmbiguousWide` (tests), `Z_AGENT_AMBIGUOUS=double|single`,
 * `RUNEWIDTH_EASTASIAN`, a terminal DSR probe, then CJK locale. Under-estimating
 * width corrupts the frame; over-estimating only shortens lines.
 */
export function isAmbiguousWide(): boolean {
	if (ambiguousWideForced !== undefined) {
		return ambiguousWideForced;
	}
	ambiguousWideDetected ??= detectAmbiguousWide();
	return ambiguousWideDetected;
}

/** Test hook / explicit override; pass undefined to restore detection. */
export function setAmbiguousWide(value: boolean | undefined): void {
	ambiguousWideForced = value;
}

/** Report the terminal's measured ambiguous width; explicit env config wins. */
export function reportAmbiguousWide(value: boolean): void {
	ambiguousWideProbed = value;
	if (ambiguousWideForced === undefined && !process.env.Z_AGENT_AMBIGUOUS) {
		ambiguousWideDetected = value;
	}
}

function isAmbiguous(code: number): boolean {
	let lo = 0;
	let hi = AMBIGUOUS_RANGES.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const [start, end] = AMBIGUOUS_RANGES[mid] ?? [0, 0];
		if (code < start) {
			hi = mid - 1;
		} else if (code > end) {
			lo = mid + 1;
		} else {
			return true;
		}
	}
	return false;
}

export function cellWidth(char: string): number {
	const code = char.codePointAt(0) ?? 0;
	if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || (code >= 0x300 && code <= 0x36f)) {
		return 0;
	}
	if (code >= 0x1100 && (code <= 0x115f || code >= 0x2e80)) {
		return 2;
	}
	return isAmbiguousWide() && isAmbiguous(code) ? 2 : 1;
}

export function padTo(text: string, width: number): string {
	const clipped = clip(text, width);
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

const ANSI_AT = new RegExp(`^${ESC}\\[[0-?]*[ -/]*[@-~]`);

/** Clip at a cell width while preserving ANSI sequences; appends an ellipsis on truncation. */
export function clipAnsi(text: string, width: number, ellipsis = "…"): string {
	if (visibleWidth(text) <= width) {
		return text;
	}
	const limit = Math.max(0, width - cellWidth(ellipsis));
	let out = "";
	let used = 0;
	let index = 0;
	while (index < text.length) {
		const seq = text[index] === ESC ? ANSI_AT.exec(text.slice(index)) : null;
		if (seq) {
			out += seq[0];
			index += seq[0].length;
			continue;
		}
		const char = String.fromCodePoint(text.codePointAt(index) ?? 0);
		const cw = cellWidth(char);
		if (used + cw > limit) {
			return `${out}${out.includes(ESC) ? "\x1b[0m" : ""}${ellipsis}`;
		}
		out += char;
		used += cw;
		index += char.length;
	}
	return out;
}

/** Pad to a cell width without dropping ANSI styling. */
export function padAnsi(text: string, width: number, ellipsis = "…"): string {
	const clipped = clipAnsi(text, width, ellipsis);
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

const ITALIC = "\x1b[3m";
const STRIKE = "\x1b[9m";

export interface TextStyle {
	tone?: Tone;
	italic?: boolean;
	strike?: boolean;
}

export interface TextSpan {
	text: string;
	style: TextStyle;
}

export function paintStyle(enabled: boolean, style: TextStyle, text: string): string {
	if (!enabled || text.length === 0) {
		return text;
	}
	let painted = style.tone ? color(true, style.tone, text) : text;
	if (style.italic) {
		painted = `${ITALIC}${painted}`;
	}
	if (style.strike) {
		painted = `${STRIKE}${painted}`;
	}
	if (style.italic || style.strike) {
		painted = `${painted}${RESET}`;
	}
	return painted;
}

function sameStyle(left: TextStyle, right: TextStyle): boolean {
	return left.tone === right.tone && left.italic === right.italic && left.strike === right.strike;
}

export function wrapSpans(spans: readonly TextSpan[], width: number): TextSpan[][] {
	const safeWidth = Math.max(1, width);
	const lines: TextSpan[][] = [];
	let current: TextSpan[] = [];
	let currentWidth = 0;

	const flush = (): void => {
		lines.push(current);
		current = [];
		currentWidth = 0;
	};

	const appendChar = (char: string, style: TextStyle): void => {
		const charWidth = cellWidth(char);
		if (currentWidth > 0 && currentWidth + charWidth > safeWidth) {
			flush();
		}
		const last = current[current.length - 1];
		if (last && sameStyle(last.style, style)) {
			last.text += char;
		} else {
			current.push({ text: char, style });
		}
		currentWidth += charWidth;
	};

	for (const span of spans) {
		const parts = span.text.split("\n");
		for (let index = 0; index < parts.length; index += 1) {
			if (index > 0) {
				flush();
			}
			for (const char of Array.from(parts[index] ?? "")) {
				appendChar(char, span.style);
			}
		}
	}
	if (current.length > 0 || lines.length === 0) {
		flush();
	}
	return lines;
}

export function paintSpans(enabled: boolean, spans: readonly TextSpan[]): string {
	return spans.map((span) => paintStyle(enabled, span.style, span.text)).join("");
}
