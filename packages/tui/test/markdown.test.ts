import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/markdown.ts";
import { visibleWidth } from "../src/text.ts";

function plain(source: string, width = 40): string[] {
	return renderMarkdown(source, width, { colors: false });
}

function stripAnsi(text: string): string {
	const esc = "\u001b";
	return text.replace(new RegExp(`${esc}\\[[0-?]*[ -/]*[@-~]`, "g"), "");
}

function columnStarts(line: string): number[] {
	const starts: number[] = [];
	let vis = 0;
	let inWord = false;
	for (const char of Array.from(line)) {
		if (char !== " ") {
			if (!inWord) {
				starts.push(vis);
				inWord = true;
			}
		} else {
			inWord = false;
		}
		vis += visibleWidth(char);
	}
	return starts;
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
		expect(plain("See [docs](https://example.com) and ![Cat](http://x/y.png)", 80)).toEqual([
			"See docs (https://example.com) and [image: Cat]",
		]);
	});

	it("drops raw HTML and active href schemes", () => {
		const lines = plain("<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n[ok](https://ok.example)");
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

	it("aligns table column gutters across rows by visible width", () => {
		const lines = plain("| A | B |\n| --- | --- |\n| a | bb |\n| 中 | x |", 20);
		expect(lines.length).toBeGreaterThanOrEqual(4);
		const [header, rule, row1, row2] = lines;
		expect(columnStarts(row1 ?? "")).toEqual(columnStarts(row2 ?? ""));
		expect(columnStarts(header ?? "")).toEqual(columnStarts(row1 ?? ""));
		expect(columnStarts(rule ?? "")).toEqual(columnStarts(row1 ?? ""));
	});

	it("repeats the blockquote marker on every wrapped continuation line", () => {
		const lines = plain("> quoted text that is long enough to wrap past the width", 20);
		const body = lines.filter((line) => line.length > 0);
		expect(body.length).toBeGreaterThan(1);
		for (const line of body) {
			expect(line.startsWith("│ ")).toBe(true);
		}
	});

	it("keeps hanging indent on every wrapped list-item continuation", () => {
		const lines = plain("- item text that is long enough to wrap past the width", 16);
		const body = lines.filter((line) => line.length > 0);
		expect(body.length).toBeGreaterThan(1);
		expect(body[0]?.startsWith("- ")).toBe(true);
		for (const line of body.slice(1)) {
			expect(line.startsWith("  ")).toBe(true);
		}
	});

	it("does not emit a dangling bullet for a nested list", () => {
		const lines = plain("- one\n  - nested");
		expect(lines.some((line) => line.trim() === "-")).toBe(false);
		expect(lines[0]).toBe("- one");
		expect(lines).toContain("  - nested");
	});

	it("keeps color output equal to monochrome after CSI strip", () => {
		const source = "## Head\n\nA **bold** [link](https://example.com)\n\n```\ncode\n```";
		const mono = renderMarkdown(source, 36, { colors: false });
		const colored = renderMarkdown(source, 36, { colors: true }).map(stripAnsi);
		expect(colored).toEqual(mono);
	});
});
