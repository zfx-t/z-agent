import { lexer, type MarkedToken, type Token, type Tokens } from "marked";
import {
	clean,
	clip,
	padTo,
	paintSpans,
	type TextSpan,
	type TextStyle,
	visibleWidth,
	wrap,
	wrapSpans,
} from "./text.ts";

export const MARKED_LEX_OPTIONS = { gfm: true, breaks: true } as const;

export interface MarkdownRenderOptions {
	colors: boolean;
}

export function renderMarkdown(source: string, width: number, options: MarkdownRenderOptions): string[] {
	const safeWidth = Math.max(1, width);
	const cleaned = clean(source);
	let tokens: ReturnType<typeof lexer>;
	try {
		tokens = lexer(cleaned, { ...MARKED_LEX_OPTIONS, silent: true });
	} catch {
		return wrap(cleaned, safeWidth);
	}
	const lines = renderTokens(tokens, safeWidth, options.colors, { quote: false, indent: "" });
	return lines.length > 0 ? lines : [""];
}

interface WalkState {
	quote: boolean;
	indent: string;
}

function renderTokens(tokens: readonly Token[], width: number, colors: boolean, state: WalkState): string[] {
	const lines: string[] = [];
	for (const token of tokens) {
		lines.push(...renderToken(token, width, colors, state));
	}
	return lines;
}

function renderToken(token: Token, width: number, colors: boolean, state: WalkState): string[] {
	const current = token as MarkedToken;
	switch (current.type) {
		case "space":
			return [""];
		case "heading":
			return renderHeading(current, width, colors, state);
		case "paragraph":
		case "text":
			return renderInlineBlock(
				current.tokens ?? [{ type: "text", raw: current.text, text: current.text }],
				width,
				colors,
				state,
				{},
			);
		case "blockquote":
			return renderTokens(current.tokens, width, colors, { ...state, quote: true });
		case "list":
			return renderList(current, width, colors, state);
		case "code":
			return renderFence(current, width, colors, state);
		case "hr":
			return [`${prefixFor(state)}${"─".repeat(Math.max(1, width - visibleWidth(prefixFor(state))))}`].map((line) =>
				paintLine(colors, [{ text: line, style: { tone: "dim" } }], width),
			);
		case "table":
			return renderTable(current, width, colors, state);
		case "html":
			return [];
		case "def":
			return [];
		default:
			if ("text" in current && typeof current.text === "string") {
				return renderInlineBlock(
					"tokens" in current && current.tokens
						? current.tokens
						: [{ type: "text", raw: current.text, text: current.text }],
					width,
					colors,
					state,
					{},
				);
			}
			return [];
	}
}

function renderHeading(token: Tokens.Heading, width: number, colors: boolean, state: WalkState): string[] {
	const marker = `${"#".repeat(Math.max(1, token.depth))} `;
	return renderInlineBlock(token.tokens, width, colors, state, {
		leading: [{ text: marker, style: { tone: "muted" } }],
		base: { tone: "strong" },
	});
}

function renderList(token: Tokens.List, width: number, colors: boolean, state: WalkState): string[] {
	const start = typeof token.start === "number" && token.start > 0 ? token.start : 1;
	const lines: string[] = [];
	token.items.forEach((item, index) => {
		const checkbox = item.task ? (item.checked ? "[x] " : "[ ] ") : "";
		const bullet = token.ordered ? `${start + index}. ` : "- ";
		const marker = `${bullet}${checkbox}`;
		const bodyTokens = item.tokens.flatMap((child) =>
			child.type === "paragraph" || child.type === "text" ? (child.tokens ?? []) : [child],
		);
		const inline = bodyTokens.every(
			(child) => child.type !== "list" && child.type !== "code" && child.type !== "blockquote",
		);
		if (inline) {
			lines.push(
				...renderInlineBlock(bodyTokens, width, colors, state, {
					leading: [{ text: marker, style: {} }],
				}),
			);
			return;
		}
		const children = item.tokens;
		const first = children[0];
		let rest = children;
		if (first && (first.type === "paragraph" || first.type === "text")) {
			const leadingTokens =
				first.tokens && first.tokens.length > 0
					? first.tokens
					: [{ type: "text", raw: first.text, text: first.text }];
			lines.push(
				...renderInlineBlock(leadingTokens, width, colors, state, {
					leading: [{ text: marker, style: {} }],
				}),
			);
			rest = children.slice(1);
		} else {
			lines.push(paintLine(colors, [{ text: `${prefixFor(state)}${marker}`, style: {} }], width));
		}
		if (rest.length > 0) {
			lines.push(...renderTokens(rest, width, colors, { ...state, indent: `${state.indent}  ` }));
		}
	});
	return lines;
}

function renderFence(token: Tokens.Code, width: number, colors: boolean, state: WalkState): string[] {
	const prefix = prefixFor(state);
	const innerWidth = Math.max(1, width - visibleWidth(prefix));
	const open = `\`\`\`${token.lang ?? ""}`;
	const close = "```";
	const body = wrap(token.text.replace(/\n$/u, ""), innerWidth).map((line) => line.trimEnd());
	return [open, ...body, close].map((line) =>
		paintLine(colors, [{ text: `${prefix}${line}`, style: { tone: "muted" } }], width),
	);
}

function renderTable(token: Tokens.Table, width: number, colors: boolean, state: WalkState): string[] {
	const prefix = prefixFor(state);
	const inner = Math.max(1, width - visibleWidth(prefix));
	const columns = token.header.length;
	if (columns === 0) {
		return [];
	}
	const gutter = 2;
	const maxCell = Math.max(3, Math.floor((inner - gutter * (columns - 1)) / columns));
	const formatRow = (cells: Tokens.TableCell[], header: boolean): string => {
		const pieces = cells.map((cell) => padTo(plainText(cell.tokens), maxCell));
		while (pieces.length < columns) {
			pieces.push(padTo("", maxCell));
		}
		const joined = pieces.slice(0, columns).join(" ".repeat(gutter));
		return paintLine(
			colors,
			[{ text: `${prefix}${clip(joined, inner)}`, style: header ? { tone: "strong" } : { tone: "muted" } }],
			width,
		);
	};
	const rule = paintLine(
		colors,
		[
			{
				text: `${prefix}${clip(Array.from({ length: columns }, () => "-".repeat(maxCell)).join(" ".repeat(gutter)), inner)}`,
				style: { tone: "dim" },
			},
		],
		width,
	);
	return [formatRow(token.header, true), rule, ...token.rows.map((row) => formatRow(row, false))];
}

function renderInlineBlock(
	tokens: readonly Token[],
	width: number,
	colors: boolean,
	state: WalkState,
	options: { leading?: TextSpan[]; base?: TextStyle },
): string[] {
	const prefix = prefixFor(state);
	const leading = options.leading ?? [];
	const markerText = leading.map((span) => span.text).join("");
	const hang = " ".repeat(visibleWidth(markerText));
	const bodyWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(markerText));
	const wrapped = wrapSpans(inlineSpans(tokens, options.base ?? {}), bodyWidth);
	return wrapped.map((line, index) => {
		const marker = index === 0 ? leading : hang.length > 0 ? [{ text: hang, style: {} }] : [];
		return paintSpans(colors, [{ text: prefix, style: { tone: "muted" } }, ...marker, ...line]);
	});
}

function prefixFor(state: WalkState): string {
	return `${state.indent}${state.quote ? "│ " : ""}`;
}

function inlineSpans(tokens: readonly Token[], base: TextStyle): TextSpan[] {
	const spans: TextSpan[] = [];
	for (const token of tokens) {
		spans.push(...inlineSpan(token, base));
	}
	return spans;
}

function inlineSpan(token: Token, base: TextStyle): TextSpan[] {
	const current = token as MarkedToken;
	switch (current.type) {
		case "strong":
			return inlineSpans(current.tokens, { ...base, tone: "strong" });
		case "em":
			return inlineSpans(current.tokens, { ...base, italic: true });
		case "del":
			return inlineSpans(current.tokens, { ...base, strike: true });
		case "codespan":
			return [{ text: `\`${current.text}\``, style: { ...base, tone: "info" } }];
		case "br":
			return [{ text: "\n", style: base }];
		case "escape":
		case "text": {
			const nested = current.type === "text" ? current.tokens : undefined;
			if (nested && nested.length > 0) {
				return inlineSpans(nested, base);
			}
			return [{ text: current.text, style: base }];
		}
		case "link":
			return linkSpans(current, base);
		case "image":
			return [{ text: current.text ? `[image: ${current.text}]` : "[image]", style: { ...base, tone: "muted" } }];
		case "html":
			return [];
		default:
			if ("text" in current && typeof current.text === "string") {
				return [{ text: current.text, style: base }];
			}
			return [];
	}
}

function linkSpans(token: Tokens.Link, base: TextStyle): TextSpan[] {
	const label = plainText(token.tokens);
	const href = safeHref(token.href);
	if (!href || href === label) {
		return [{ text: label, style: { ...base, tone: "info" } }];
	}
	return [
		{ text: label, style: { ...base, tone: "info" } },
		{ text: ` (${href})`, style: { tone: "muted" } },
	];
}

function safeHref(href: string): string | undefined {
	const value = clean(href).trim();
	if (value.length === 0) {
		return undefined;
	}
	const lower = value.toLowerCase();
	if (lower.startsWith("javascript:") || lower.startsWith("data:") || lower.startsWith("vbscript:")) {
		return undefined;
	}
	return value;
}

function plainText(tokens: readonly Token[] | undefined): string {
	if (!tokens || tokens.length === 0) {
		return "";
	}
	return inlineSpans(tokens, {})
		.map((span) => span.text)
		.join("");
}

function paintLine(colors: boolean, spans: readonly TextSpan[], width: number): string {
	const wrapped = wrapSpans(spans, width);
	return paintSpans(colors, wrapped[0] ?? []);
}
