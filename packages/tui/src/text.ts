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

export function cellWidth(char: string): number {
	const code = char.codePointAt(0) ?? 0;
	if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || (code >= 0x300 && code <= 0x36f)) {
		return 0;
	}
	return code >= 0x1100 && (code <= 0x115f || code >= 0x2e80) ? 2 : 1;
}

export function padTo(text: string, width: number): string {
	const clipped = clip(text, width);
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
