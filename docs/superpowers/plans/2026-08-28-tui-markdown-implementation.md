# TUI Assistant Markdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render assistant transcript entries as GitHub-Flavored Markdown in the existing Quiet Console TUI, without replacing the renderer, adding Ink, or emitting untrusted HTML/ANSI.

**Architecture:** Keep `TuiTranscriptEntry.text` as raw Markdown source. On every paint, `@z-agent/tui` sanitizes that source, lexes it with `marked` (lexer only, never `parse()`), and paints a wrap-then-style line list using the existing semantic tokens. `LineScreen` already replaces frames in place, so streaming re-lexes the full assistant buffer instead of appending rendered output. `@z-agent/agent` and print-mode stdout stay unchanged.

**Tech Stack:** TypeScript 5.9 (erasable syntax), Node.js 22+, Vitest, Biome, existing `@z-agent/tui` line-diff TUI, `marked@18.0.11` (lexer only). No Ink, no `marked-terminal`, no Glow binary, no highlight.js.

## Outcome Contract

```text
User: Coding-agent operator
Trigger / real entrypoint: Interactive TUI (`npm run z-agent`) watching an assistant reply
Primary journey: Model streams Markdown (headings, emphasis, lists, fenced code, links, tables); the AI transcript shows structured text instead of raw markers
Observable success: `# Title` appears as a heading marker + bold title; `**bold**` loses the asterisks and is bold when color is on; a fence is a labeled code block; 80x24 has no horizontal scroll; NO_COLOR keeps the same markers; untrusted ESC/HTML does not style the terminal
Non-goals: print-mode Markdown, user/thinking/tool Markdown, syntax highlighting, OSC 8 hyperlinks, Ink/pi-tui/native renderer, emoji shortcodes, Mermaid/math
Constraints: ADR-0016 clean-room TUI; wrap/clip must remain cell-width correct; clean() still strips untrusted ANSI before lex; no new agent-core effect
Proof: Focused Vitest for text metrics, markdown fixtures, and renderFrame/session streaming; then npm run check; then a real TTY journey with a Markdown-heavy reply
```

## Global Constraints

- Node `>=22`; install with `npm install --ignore-scripts` only. Pin direct deps to exact versions.
- Erasable TypeScript only: no parameter properties, `enum`, `namespace`, or `import =`.
- Relative imports include `.ts` extensions. Package imports (`marked`) stay bare.
- `@z-agent/agent` must not gain filesystem, config, TUI, or Markdown imports. Effect boundaries remain `streamAssistant` and `tool.execute`.
- Do not import `@earendil-works/*`, `ink`, `marked-terminal`, `cli-highlight`, `highlight.js`, or a Glow/Glamour binary.
- Never call `marked.parse` / `marked.parseInline`. Lexer tokens only. Do not emit HTML.
- `NO_COLOR` and `colors: false` must keep heading markers, list markers, code fences, and link URLs visible. Color never carries structure alone.
- Existing uncommitted TUI/skills/garden work is user-owned; patch around it and do not revert it.
- Do not create commits unless the user explicitly asks. Stage no files during implementation. Skip every Commit step below unless asked.

---

## File Map

| File | Responsibility |
| --- | --- |
| Create `packages/tui/src/text.ts` | Shared cell-width metrics, `clean`, wrap/clip, semantic `Tone` paint, and later `wrapSpans` / `paintStyle`. |
| Create `packages/tui/test/text.test.ts` | Unit tests for wrap, CJK width, ANSI stripping, and styled-span wrapping. |
| Create `packages/tui/src/markdown.ts` | Sanitize → `lexer` → Quiet Console lines. Filesystem-free. |
| Create `packages/tui/test/markdown.test.ts` | Fixture tests for GFM subset, width, monochrome/color equivalence, and unsafe href/HTML/ANSI. |
| Modify `packages/tui/package.json` | Exact `marked@18.0.11` dependency. |
| Modify `package-lock.json` | Lockfile for `marked` (via `--ignore-scripts` install). |
| Modify `packages/tui/src/layout.ts` | Import text helpers; render `kind === "assistant"` through `renderMarkdown`. |
| Modify `packages/tui/test/tui.test.ts` | Frame assertions for Markdown assistant rows; keep control-stripping and 80x24 coverage. |
| Modify `packages/tui/src/index.ts` | No new public Markdown export unless a test needs it; keep renderer package-internal. |
| Create `docs/adr/0023-tui-markdown.md` | Lexer-only `marked` + first-party renderer decision. |
| Modify `docs/adr/README.md` | Index ADR-0023. |
| Modify `docs/glossary.md` | Term for assistant Markdown rendering. |
| Modify `docs/roadmap.md` | Phase 2.9. |
| Modify `docs/tui-future-direction.md` | R7 Markdown; non-goals stay. |
| Modify `packages/tui/README.md` | Operator-visible Markdown behavior. |

## Locked Product Decisions

1. **Surface:** Only `TuiTranscriptKind === "assistant"` is Markdown. User, thinking, tool, info, warning, and error stay plain `wrap(clean(text))`. Print mode (`packages/cli/src/render.ts`) stays raw `text_delta` bytes for pipelines.
2. **Source of truth:** `entry.text` remains the raw Markdown string. `appendAssistantDelta` does not parse. Parsing is a pure paint function.
3. **Parser:** `marked@18.0.11` via `import { lexer, type Token, type Tokens } from "marked"`. Options are exactly `{ gfm: true, breaks: true }`. `breaks: true` keeps single newlines from LLM replies. Never HTML-compile.
4. **Sanitize before lex:** `clean()` first (strip CSI/ANSI and C0 controls except `\n` / `\t`, tabs → two spaces). Then lex. Then apply *our* SGR. Untrusted ESC in model text cannot style the terminal.
5. **Wrap then paint:** Measure and wrap on plain span text with existing `cellWidth`. Apply `Tone` / italic / strike only after line breaks are known. Do not wrap a string that already contains SGR.
6. **Streaming:** Re-lex the full assistant buffer on every `renderFrame`. Do not append rendered lines to a second scrollback. `LineScreen.paint` already diffs by row. Do not add a mutable-tail commit protocol in this slice.
7. **Monochrome structure (required):**

   | Construct | Visible marker in both color and `NO_COLOR` |
   | --- | --- |
   | Heading depth `n` | `"#".repeat(n) + " "` then title |
   | Strong / emphasis | markers stripped; color uses bold / italic |
   | Inline code | keep surrounding `` ` `` |
   | Unordered list | `- ` |
   | Ordered list | `${n}. ` |
   | Task list | `- [ ] ` or `- [x] ` |
   | Blockquote | `│ ` |
   | Horizontal rule | `─` repeated to body width |
   | Fenced / indented code | first line `` ```lang `` (lang optional), then body, then `` ``` `` |
   | Link | `label` if label equals href; otherwise `label (href)` |
   | Image | `[image: alt]` or `[image]` |
   | Table | header, `---` rule, clipped columns, `  ` gutters |

8. **Unsafe content:** Ignore `html` tokens (no raw HTML). Drop `javascript:`, `data:`, and `vbscript:` hrefs (show label only). Images never fetch. `def` tokens produce no lines.
9. **No syntax highlighting.** Fences show a language label and dim/muted body. No `highlight.js` / `cli-highlight`.
10. **No OSC 8, no emoji shortcodes, no box-drawing cards around prose.** Quiet Console: labels and markers, not dashboard chrome.
11. **Width:** Every Markdown line's visible width is `<= bodyWidth`. 80x24 remains the supported minimum. Prefer wrap over truncation except table cells, which clip with `...`.
12. **Out of scope:** print Markdown, thinking Markdown, tool-output Markdown, Mermaid, math, theme marketplace, mouse link click, copy-as-source command.

## Why this stack (survey)

Mature options considered in 2026, ranked for *this* repo (ADR-0016: no Ink, no native addon, no pi-tui; `clean()` currently strips ANSI from transcript bodies; `layout.ts` owns wrap and tokens):

| Approach | Maturity | Fit | Decision |
| --- | --- | --- | --- |
| **`marked` lexer + first-party painter** | `marked` ~70M weekly downloads, v18.0.11 (2026-08-24), stable `lexer()` / `Token` types | Maps tokens onto existing `Tone`, wrap, and `LineScreen`. Zero HTML. One pinned dep. | **Adopt** |
| `marked-terminal` 7.x | Highest-download ANSI renderer (~7M/week) | Emits chalk ANSI; default `emoji: true`; pulls `cli-table3` + `cli-highlight`; wrap fights `clean()` / prefix gutter | Reject |
| `marked-terminal-renderer` 2.x | Newer marked-v18 extension | Async `marked.parse`, own themes, still ANSI-string output | Reject |
| Ink + `ink-markdown` | Common React TUI path | ADR-0016 forbids Ink | Reject |
| Charmbracelet Glow / Glamour | Gold-standard *Go* terminal Markdown | External binary / native; not a pin-able TS dep | Reject |
| `@oakoliver/glamour` | TS Glamour port, first publish 2026-03 | Custom parser, ANSI string, very new | Reject |
| Markdansi (`createMarkdownStreamer`) | Streaming-first, micromark-based | Own wrap/theme/ANSI; young; would replace Quiet Console metrics | Reject |
| Hand-rolled GFM | Zero dep | Reimplements a solved lexer; worse tables/lists/autolinks | Reject |

Coding-agent TUI lesson (OpenCode / Crush / Codex, 2026): bugs come from **appending** a full re-render into scrollback, or from committing list/fence tails before the CommonMark block is stable. Z Agent already stores raw text and **replaces** the frame. Full re-lex per paint is the correct v1. A Codex-style mutable tail is a follow-up only if fixture tests show unacceptable heading/list jitter.

UX rules applied from ui-ux-pro-max (terminal stack is not in that skill's web/native list; Quiet Console tokens stay authoritative — do not adopt the skill's "Exaggerated Minimalism" landing palette):

- `color-not-only` / `color-not-decorative-only`: markers remain in `NO_COLOR`.
- `heading-hierarchy`: keep `#` / `##` prefixes; do not skip visible depth.
- `horizontal-scroll` / `truncation-strategy`: wrap prose; ellipsis only on table cells.
- `no-emoji-icons`: ASCII `-`, `[ ]`, `[x]`, `│`, `` ``` ``.
- `contrast-readability`: reuse existing 256-color tokens (`strong`, `muted`, `info`, `dim`). Do not introduce gray-on-gray body.
- `reduced-motion`: no animated reveal of Markdown blocks.
- `alt-text`: images become `[image: alt]`.

## Contract Map

Later tasks must use these names. Do not invent aliases such as `parseMarkdownHtml`, `renderGfm`, or `markdownToAnsi`.

```ts
// packages/tui/src/text.ts
export type Tone = "accent" | "dim" | "error" | "info" | "muted" | "success" | "strong" | "warning";

export interface TextStyle {
	tone?: Tone;
	italic?: boolean;
	strike?: boolean;
}

export interface TextSpan {
	text: string;
	style: TextStyle;
}

export function clean(text: string): string;
export function wrap(text: string, width: number): string[];
export function clip(text: string, width: number): string;
export function visibleWidth(text: string): number;
export function cellWidth(char: string): number;
export function padTo(text: string, width: number): string;
export function color(enabled: boolean, tone: Tone, text: string): string;
export function paintStyle(enabled: boolean, style: TextStyle, text: string): string;
export function wrapSpans(spans: readonly TextSpan[], width: number): TextSpan[][];
export function paintSpans(enabled: boolean, spans: readonly TextSpan[]): string;

// packages/tui/src/markdown.ts
export interface MarkdownRenderOptions {
	colors: boolean;
}

export function renderMarkdown(source: string, width: number, options: MarkdownRenderOptions): string[];
```

Lexer options (only these):

```ts
export const MARKED_LEX_OPTIONS = { gfm: true, breaks: true } as const;
```

---

### Task 1: Extract shared terminal text metrics

**Files:**
- Create: `packages/tui/src/text.ts`
- Create: `packages/tui/test/text.test.ts`
- Modify: `packages/tui/src/layout.ts` (move helpers; keep `renderFrame` behavior identical)

**Interfaces:**
- Consumes: current private helpers in `packages/tui/src/layout.ts`
- Produces: `Tone`, `clean`, `wrap`, `clip`, `visibleWidth`, `cellWidth`, `padTo`, `color`

- [ ] **Step 1: Write the failing text-metric tests**

Create `packages/tui/test/text.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { clean, clip, color, visibleWidth, wrap } from "../src/text.ts";

describe("text metrics", () => {
	it("strips CSI and control characters but keeps newlines", () => {
		expect(clean("a\x1b[31mb\n\tc\x07")).toBe("ab\n  c");
	});

	it("wraps by terminal cell width including CJK", () => {
		expect(wrap("你好world", 5)).toEqual(["你好w", "orld"]);
	});

	it("treats empty input as a single blank line", () => {
		expect(wrap("", 10)).toEqual([""]);
	});

	it("clips with an ellipsis and ignores styling width from CSI", () => {
		expect(clip("\x1b[1mhello world\x1b[0m", 8)).toBe("hello...");
		expect(visibleWidth(color(true, "strong", "hi"))).toBe(2);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --workspace @z-agent/tui -- test/text.test.ts`

Expected: FAIL with `Cannot find module '../src/text.ts'`

- [ ] **Step 3: Move the helpers out of layout.ts**

Create `packages/tui/src/text.ts` with this exact contents (behavior copied from `layout.ts`):

```ts
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
```

In `packages/tui/src/layout.ts`:

1. Add:

```ts
import { type Tone, clip, color, clean, padTo, visibleWidth, wrap } from "./text.ts";
```

2. Delete the local `type Tone`, `ANSI`, `RESET`, `ESC`, `ANSI_PATTERN`, and the local `padTo` / `color` / `clean` / `removeControls` / `wrap` / `clip` / `visibleWidth` / `cellWidth` functions.
3. Keep `paint` as:

```ts
const paint = (tone: Tone, text: string): string => color(state.colors !== false, tone, text);
```

Do not change `renderFrame` output.

- [ ] **Step 4: Run text tests and existing TUI tests**

Run:

```bash
npm test --workspace @z-agent/tui -- test/text.test.ts test/tui.test.ts
```

Expected: PASS. Existing frames still contain `YOU hi`, `AI  hello`, and still strip untrusted CSI from assistant source.

- [ ] **Step 5: Commit**

```bash
git add packages/tui/src/text.ts packages/tui/test/text.test.ts packages/tui/src/layout.ts
git commit -m "refactor(tui): extract shared terminal text metrics"
```

---

### Task 2: Quiet Console Markdown renderer

**Files:**
- Modify: `packages/tui/package.json`
- Modify: `package-lock.json`
- Modify: `packages/tui/src/text.ts`
- Modify: `packages/tui/test/text.test.ts`
- Create: `packages/tui/src/markdown.ts`
- Create: `packages/tui/test/markdown.test.ts`

**Interfaces:**
- Consumes: Task 1 `clean`, `wrap`, `clip`, `visibleWidth`, `cellWidth`, `color`, `Tone`
- Produces: `TextStyle`, `TextSpan`, `wrapSpans`, `paintStyle`, `paintSpans`, `MARKED_LEX_OPTIONS`, `renderMarkdown`

- [ ] **Step 1: Pin marked**

Run from the repo root:

```bash
npm install --ignore-scripts --save-exact --workspace @z-agent/tui marked@18.0.11
```

Expected: `packages/tui/package.json` contains `"marked": "18.0.11"` under `dependencies`. Do not add chalk, cli-table3, or highlight packages.

- [ ] **Step 2: Write failing renderer tests**

Append to `packages/tui/test/text.test.ts`:

```ts
import { paintSpans, wrapSpans } from "../src/text.ts";

describe("styled spans", () => {
	it("wraps spans on cell width and keeps style boundaries", () => {
		const lines = wrapSpans(
			[
				{ text: "hello ", style: { tone: "strong" } },
				{ text: "世界", style: { tone: "info" } },
			],
			8,
		);
		expect(lines).toEqual([
			[
				{ text: "hello ", style: { tone: "strong" } },
				{ text: "世", style: { tone: "info" } },
			],
			[{ text: "界", style: { tone: "info" } }],
		]);
	});

	it("paints nothing extra when colors are off", () => {
		expect(paintSpans(false, [{ text: "x", style: { tone: "strong", italic: true } }])).toBe("x");
	});
});
```

Create `packages/tui/test/markdown.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/markdown.ts";
import { visibleWidth } from "../src/text.ts";

function plain(source: string, width = 40): string[] {
	return renderMarkdown(source, width, { colors: false });
}

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

describe("renderMarkdown", () => {
	it("renders headings, emphasis, and inline code with stable markers", () => {
		expect(plain("# Title\n\nHello **bold** and `x`.")).toEqual(["# Title", "", "Hello bold and `x`."]);
	});

	it("preserves single newlines from GFM breaks", () => {
		expect(plain("line one\nline two")).toEqual(["line one", "line two"]);
	});

	it("renders lists, tasks, quotes, and rules", () => {
		const lines = plain("- one\n- [x] two\n\n1. first\n\n> quoted\n\n---");
		expect(lines).toContain("- one");
		expect(lines).toContain("- [x] two");
		expect(lines).toContain("1. first");
		expect(lines).toContain("│ quoted");
		expect(lines.some((line) => line.startsWith("─"))).toBe(true);
	});

	it("wraps fenced code and keeps fence markers", () => {
		const lines = plain("```ts\nconst value = 1;\n```", 12);
		expect(lines[0]).toBe("```ts");
		expect(lines).toContain("const value");
		expect(lines[lines.length - 1]).toBe("```");
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(12);
		}
	});

	it("formats links and image placeholders without fetching", () => {
		expect(plain("See [docs](https://example.com) and ![Cat](http://x/y.png)")).toEqual([
			"See docs (https://example.com) and [image: Cat]",
		]);
	});

	it("drops raw HTML and active href schemes", () => {
		const lines = plain('<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n[ok](https://ok.example)');
		expect(lines.join("\n")).not.toContain("<script>");
		expect(lines.join("\n")).not.toContain("javascript:");
		expect(lines.join("\n")).toContain("bad");
		expect(lines.join("\n")).toContain("ok (https://ok.example)");
	});

	it("strips untrusted CSI before lexing", () => {
		expect(plain("# Hi\x1b[31m")).toEqual(["# Hi"]);
	});

	it("clips table cells to the body width", () => {
		const lines = plain("| Name | Value |\n| --- | --- |\n| alpha | beta |", 16);
		expect(lines[0]).toContain("Name");
		expect(lines[1]).toMatch(/^-/);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(16);
		}
	});

	it("keeps color output equal to monochrome after CSI strip", () => {
		const source = "## Head\n\nA **bold** [link](https://example.com)\n\n```\ncode\n```";
		const mono = renderMarkdown(source, 36, { colors: false });
		const colored = renderMarkdown(source, 36, { colors: true }).map(stripAnsi);
		expect(colored).toEqual(mono);
	});
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test --workspace @z-agent/tui -- test/text.test.ts test/markdown.test.ts`

Expected: FAIL — `wrapSpans` / `renderMarkdown` are not exported.

- [ ] **Step 4: Implement span wrap and the Markdown renderer**

Add to `packages/tui/src/text.ts` (keep existing exports):

```ts
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
```

Create `packages/tui/src/markdown.ts`:

```ts
import { lexer, type Token, type Tokens } from "marked";
import {
	type TextSpan,
	type TextStyle,
	clip,
	clean,
	paintSpans,
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
	const tokens = lexer(clean(source), MARKED_LEX_OPTIONS);
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
	switch (token.type) {
		case "space":
			return [""];
		case "heading":
			return renderHeading(token, width, colors, state);
		case "paragraph":
		case "text":
			return renderInlineBlock(token.tokens ?? [{ type: "text", raw: token.text, text: token.text }], width, colors, state, {});
		case "blockquote":
			return renderTokens(token.tokens, width, colors, { ...state, quote: true });
		case "list":
			return renderList(token, width, colors, state);
		case "code":
			return renderFence(token, width, colors, state);
		case "hr":
			return [`${prefixFor(state)}${"─".repeat(Math.max(1, width - visibleWidth(prefixFor(state))))}`].map((line) =>
				paintLine(colors, [{ text: line, style: { tone: "dim" } }], width),
			);
		case "table":
			return renderTable(token, width, colors, state);
		case "html":
			return [];
		case "def":
			return [];
		default:
			if ("text" in token && typeof token.text === "string") {
				return renderInlineBlock(
					"tokens" in token && token.tokens ? token.tokens : [{ type: "text", raw: token.text, text: token.text }],
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
		lines.push(paintLine(colors, [{ text: `${prefixFor(state)}${marker}`, style: {} }], width));
		lines.push(...renderTokens(item.tokens, width, colors, { ...state, indent: `${state.indent}  ` }));
	});
	return lines;
}

function renderFence(token: Tokens.Code, width: number, colors: boolean, state: WalkState): string[] {
	const prefix = prefixFor(state);
	const innerWidth = Math.max(1, width - visibleWidth(prefix));
	const open = `\`\`\`${token.lang ?? ""}`;
	const close = "```";
	const body = wrap(token.text.replace(/\n$/u, ""), innerWidth);
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
		const pieces = cells.map((cell) => clip(plainText(cell.tokens), maxCell));
		while (pieces.length < columns) {
			pieces.push("");
		}
		const joined = pieces
			.slice(0, columns)
			.map((cell) => cell.padEnd(Math.min(maxCell, Math.max(cell.length, 1)), " "))
			.join(" ".repeat(gutter));
		return paintLine(
			colors,
			[{ text: `${prefix}${clip(joined, inner)}`, style: header ? { tone: "strong" } : { tone: "muted" } }],
			width,
		);
	};
	const rule = paintLine(
		colors,
		[{ text: `${prefix}${clip(Array.from({ length: columns }, () => "-".repeat(Math.min(3, maxCell))).join(" ".repeat(gutter)), inner)}`, style: { tone: "dim" } }],
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
	const prefixSpan: TextSpan = { text: prefix, style: { tone: "muted" } };
	const leading = options.leading ?? [];
	const spans = [prefixSpan, ...leading, ...inlineSpans(tokens, options.base ?? {})];
	const innerWidth = width;
	return wrapSpans(spans, innerWidth).map((line) => paintSpans(colors, line));
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
	switch (token.type) {
		case "strong":
			return inlineSpans(token.tokens, { ...base, tone: "strong" });
		case "em":
			return inlineSpans(token.tokens, { ...base, italic: true });
		case "del":
			return inlineSpans(token.tokens, { ...base, strike: true });
		case "codespan":
			return [{ text: `\`${token.text}\``, style: { ...base, tone: "info" } }];
		case "br":
			return [{ text: "\n", style: base }];
		case "escape":
		case "text":
			if (token.tokens && token.tokens.length > 0) {
				return inlineSpans(token.tokens, base);
			}
			return [{ text: token.text, style: base }];
		case "link":
			return linkSpans(token, base);
		case "image":
			return [{ text: token.text ? `[image: ${token.text}]` : "[image]", style: { ...base, tone: "muted" } }];
		case "html":
			return [];
		default:
			if ("text" in token && typeof token.text === "string") {
				return [{ text: token.text, style: base }];
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
	return inlineSpans(tokens, {}).map((span) => span.text).join("");
}

function paintLine(colors: boolean, spans: readonly TextSpan[], width: number): string {
	const wrapped = wrapSpans(spans, width);
	return paintSpans(colors, wrapped[0] ?? []);
}
```

- [ ] **Step 5: Run renderer tests**

Run: `npm test --workspace @z-agent/tui -- test/text.test.ts test/markdown.test.ts`

Expected: PASS. If a fixture's exact line breaks differ (extra blank `space` tokens), assert with `toContain` / filtered empty lines only where the test already does; do not weaken the heading/emphasis/link/HTML cases.

- [ ] **Step 6: Commit**

```bash
git add packages/tui/package.json package-lock.json packages/tui/src/text.ts packages/tui/test/text.test.ts packages/tui/src/markdown.ts packages/tui/test/markdown.test.ts
git commit -m "feat(tui): render GFM assistant text with marked lexer"
```

---

### Task 3: Paint assistant rows through the Markdown renderer

**Files:**
- Modify: `packages/tui/src/layout.ts`
- Modify: `packages/tui/test/tui.test.ts`

**Interfaces:**
- Consumes: `renderMarkdown(source, width, { colors })`
- Produces: assistant transcript bodies as Markdown lines; other kinds unchanged

- [ ] **Step 1: Write failing frame tests**

In `packages/tui/test/tui.test.ts`, add inside `describe("renderFrame"`:

```ts
	it("renders assistant markdown while leaving user text literal", () => {
		const frame = renderFrame(
			{
				status: "model=gpt",
				transcript: [
					{ id: "user", kind: "user", text: "use **bold**" },
					{
						id: "assistant",
						kind: "assistant",
						text: "# Done\n\nUse `renderMarkdown` and [docs](https://example.com).",
					},
				],
				editorLines: [""],
				streaming: false,
				colors: false,
			},
			72,
			16,
		).map(stripAnsi);
		const text = frame.join("\n");
		expect(text).toContain("YOU use **bold**");
		expect(text).toContain("# Done");
		expect(text).toContain("Use `renderMarkdown` and docs (https://example.com).");
		expect(text).not.toContain("[docs](https://example.com)");
		for (const line of frame) {
			expect(line.length).toBeLessThanOrEqual(72);
		}
	});

	it("keeps 80x24 assistant markdown inside the viewport", () => {
		const frame = renderFrame(
			{
				status: "model=gpt",
				transcript: [
					{
						id: "assistant",
						kind: "assistant",
						text: "```js\nconsole.log('abcdefghijklmnopqrstuvwxyz0123456789');\n```",
					},
				],
				editorLines: ["|"],
				streaming: true,
				colors: false,
			},
			80,
			24,
		).map(stripAnsi);
		expect(frame).toHaveLength(24);
		expect(frame.join("\n")).toContain("```js");
		for (const line of frame) {
			expect(line.length).toBeLessThanOrEqual(80);
		}
	});
```

Also add this session-level test in the existing `InteractiveTui` describe, using the same stdin/stdout stubs as the scroll test:

```ts
	it("re-renders streamed assistant markdown in place", () => {
		const writes: string[] = [];
		const stdout = {
			write: (chunk: string) => {
				writes.push(chunk);
				return true;
			},
			columns: 60,
			rows: 16,
		} as unknown as NodeJS.WriteStream;
		const stdin = { isTTY: false, on() {}, off() {}, setRawMode() {} } as unknown as NodeJS.ReadStream;
		const tui = new InteractiveTui({ stdin, stdout, colors: false });
		tui.appendAssistantDelta("# Hel");
		tui.appendAssistantDelta("lo\n\n**ok**");
		const frame = stripAnsi(writes[writes.length - 1] ?? "");
		expect(frame).toContain("# Hello");
		expect(frame).toContain("ok");
		expect(frame).not.toContain("**ok**");
		expect((frame.match(/# Hello/g) ?? []).length).toBe(1);
		tui.close();
	});
```

- [ ] **Step 2: Run frame tests to verify they fail**

Run: `npm test --workspace @z-agent/tui -- test/tui.test.ts`

Expected: FAIL because assistant text still shows `[docs](https://example.com)` and `**ok**`.

- [ ] **Step 3: Wire assistant entries only**

In `packages/tui/src/layout.ts`:

1. Add `import { renderMarkdown } from "./markdown.ts";`
2. In `transcriptLines`, change the entry call from `renderTranscriptEntry(entry, width, paint, selected)` to:

```ts
rendered.push(...renderTranscriptEntry(entry, width, paint, selected, state.colors !== false));
```

3. Replace `renderTranscriptEntry` with:

```ts
function renderTranscriptEntry(
	entry: TuiTranscriptEntry | string,
	width: number,
	paint: (tone: Tone, text: string) => string,
	selected: boolean,
	colors: boolean,
): string[] {
	const resolved = typeof entry === "string" ? legacyEntry(entry) : entry;
	const presentation = transcriptPresentation(resolved);
	const timestamp = resolved.createdAt === undefined ? "" : `${formatTime(resolved.createdAt)} `;
	const prefix = `${selected ? ">" : " "}${timestamp}${presentation.label} `;
	const continuation = " ".repeat(visibleWidth(prefix));
	const bodyWidth = Math.max(1, width - visibleWidth(prefix));
	const wrapped =
		resolved.kind === "assistant"
			? renderMarkdown(resolved.text, bodyWidth, { colors })
			: wrap(clean(presentation.text), bodyWidth);
	return wrapped.map((part, index) => {
		const marker = index === 0 ? prefix : continuation;
		return `${paint(selected ? "accent" : presentation.tone, marker)}${part}`;
	});
}
```

Keep `clean()` on non-assistant bodies. Assistant sanitizing happens inside `renderMarkdown`.

Do not Markdown-render inspector `detailLines`, editor lines, confirm, picker, or completion rows.

- [ ] **Step 4: Run TUI tests**

Run: `npm test --workspace @z-agent/tui -- test/tui.test.ts test/markdown.test.ts test/text.test.ts`

Expected: PASS. The existing `"AI  hello"` and `"line two"` cases still pass. The control-stripping test still forbids leftover CSI from the *source* (`\x1b[31m`); our own SGR may appear before `stripAnsi`.

- [ ] **Step 5: Commit**

```bash
git add packages/tui/src/layout.ts packages/tui/test/tui.test.ts
git commit -m "feat(tui): paint assistant transcript rows as markdown"
```

---

### Task 4: Record the decision and prove the product path

**Files:**
- Create: `docs/adr/0023-tui-markdown.md`
- Modify: `docs/adr/README.md`
- Modify: `docs/glossary.md`
- Modify: `docs/roadmap.md`
- Modify: `docs/tui-future-direction.md`
- Modify: `packages/tui/README.md`

**Interfaces:**
- Consumes: Task 2–3 names (`renderMarkdown`, `marked@18.0.11`, assistant-only)
- Produces: operator docs and ADR-0023

- [ ] **Step 1: Write ADR-0023**

Create `docs/adr/0023-tui-markdown.md`:

```md
# ADR-0023: Assistant Markdown via marked lexer

## Status

Accepted

## Context

Assistant replies are Markdown. `@z-agent/tui` currently wraps raw `entry.text`, so operators see `**`, fences, and link syntax. ADR-0016 forbids Ink, pi-tui, and native addons. `layout.ts` already owns cell-width wrap and semantic tokens, and `clean()` strips untrusted ANSI from transcript bodies.

## Decision

Lex assistant transcript text with `marked@18.0.11` (`gfm: true`, `breaks: true`) and paint a first-party Quiet Console rendering.

- Store raw Markdown on `TuiTranscriptEntry.text`.
- Sanitize with `clean()` before `lexer()`. Never call `marked.parse`.
- Wrap plain spans, then apply existing `Tone` plus italic/strike.
- Re-lex the full assistant buffer on each paint. `LineScreen` replaces rows in place.
- Keep structure visible under `NO_COLOR` via ASCII markers (`#`, `-`, `` ``` ``, `│ `, `[image: alt]`).

## Consequences

- `@z-agent/tui` gains one exact-pinned dependency.
- Print mode, user/thinking/tool rows, and syntax highlighting stay out of scope until a later ADR.
- HTML tokens and `javascript:` / `data:` / `vbscript:` hrefs are dropped.

## Alternatives

- `marked-terminal` / `marked-terminal-renderer` (rejected: ANSI-string output, emoji/highlight/table deps, fights `clean()` and the AI gutter)
- Ink markdown (rejected: ADR-0016)
- Glow / Glamour binary or `@oakoliver/glamour` (rejected: native/external or unproven parser)
- Markdansi streamer (rejected: replaces wrap/theme; young)
- Hand-rolled GFM (rejected: worse lexer than `marked`)
```

Add this row to the table in `docs/adr/README.md`:

```md
| [0023](0023-tui-markdown.md) | Assistant Markdown via marked lexer | Accepted |
```

- [ ] **Step 2: Update glossary, roadmap, and TUI docs**

Add to `docs/glossary.md` after the Coding product entry:

```md
## Assistant Markdown

TUI-only presentation of `assistant` transcript text. `@z-agent/tui` lexes GFM with `marked` and paints Quiet Console markers. The stored message text stays raw Markdown. Print mode does not render Markdown. (ADR-0023)
```

Add to `docs/roadmap.md`:

```md
## Phase 2.9 — TUI assistant Markdown

Interactive assistant rows render GFM (headings, emphasis, lists, fences, links, tables) through `marked` lexer + first-party painter. Print mode stays raw. (ADR-0023)
```

In `docs/tui-future-direction.md`, under Current Base, add:

```md
- GFM rendering for assistant transcript entries (headings, lists, fences, links, tables) with monochrome markers
```

And add a delivery item after R6:

```md
### R7: Assistant Markdown (this slice)

Acceptance:

- assistant rows render GFM without horizontal scroll at 80x24;
- user/thinking/tool rows remain literal;
- `NO_COLOR` keeps `#`, list markers, fences, and link hrefs;
- untrusted CSI/HTML cannot style or execute;
- streaming updates replace the AI body in place (no duplicated `# Hello`).
```

In `packages/tui/README.md`, after the first paragraph, add:

```md
Assistant transcript text is GitHub-Flavored Markdown: headings, emphasis, lists,
fenced code, links, and tables. User input, thinking, and tool rows stay literal.
`NO_COLOR` keeps the same markers without SGR. Print mode is not Markdown-aware.
```

- [ ] **Step 3: Run the full package check**

Run:

```bash
npm test --workspace @z-agent/tui -- test/text.test.ts test/markdown.test.ts test/tui.test.ts
npm run check
```

Expected: all listed tests PASS; `npm run check` exits 0 (Biome + all package `tsc --noEmit`).

- [ ] **Step 4: Prove the real entrypoint**

In an 80x24-or-wider TTY with a configured model:

1. `npm run z-agent`
2. Prompt: `Reply with a heading, a bold word, a bullet list, a ts fence containing a 40-char line, and a markdown link.`
3. Confirm the AI row shows `#` / bold / `-` / `` ```ts `` / `label (url)` rather than raw source.
4. Confirm the composer stays usable during stream and the heading does not duplicate.
5. Run once with `NO_COLOR=1` and confirm markers remain.

Do not claim done from unit tests alone.

- [ ] **Step 5: Commit**

```bash
git add docs/adr/0023-tui-markdown.md docs/adr/README.md docs/glossary.md docs/roadmap.md docs/tui-future-direction.md packages/tui/README.md
git commit -m "docs: record TUI assistant markdown (ADR-0023)"
```

---

## Self-Review

**1. Spec coverage**

| Locked decision | Task |
| --- | --- |
| Assistant-only Markdown | Task 3 (`kind === "assistant"`) |
| Raw `entry.text` + paint-time lex | Task 2–3; session API unchanged |
| `marked@18.0.11` lexer, `gfm` + `breaks` | Task 2 |
| `clean()` before lex; no `parse()` | Task 2 `renderMarkdown` |
| Wrap then paint | Task 2 `wrapSpans` / `paintSpans` |
| Full re-lex streaming, in-place frame | Task 3 session test |
| Monochrome markers | Task 2 fixtures + Task 3 `colors: false` |
| HTML / active href drop | Task 2 |
| No highlight / OSC 8 / print MD | Non-goals; print renderer not modified |
| 80x24 no horizontal scroll | Task 2 fence width + Task 3 80x24 frame |
| ADR / glossary / roadmap / README | Task 4 |

**2. Placeholder scan**

No TBD, no "implement later", no "write tests for the above", no "similar to Task N" without code. List items unwrap `paragraph`/`text` children before applying `- ` / `1. ` markers so indent is not doubled.

**3. Type consistency**

`renderMarkdown(source, width, { colors })` is the only layout integration name. `Tone` lives in `text.ts`. `MARKED_LEX_OPTIONS` is `{ gfm: true, breaks: true }`. No `markdownToAnsi` / `parseMarkdownHtml`.
