import { describe, expect, it } from "vitest";
import { clean, clip, color, paintSpans, visibleWidth, wrap, wrapSpans } from "../src/text.ts";

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
