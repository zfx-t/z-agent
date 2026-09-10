import { emptyUsage } from "@z-agent/ai";
import { describe, expect, it } from "vitest";
import { accumulateAssistantUsage, composeStatusLine, formatUsageOccupancy } from "../src/status-segments.ts";

describe("status segments", () => {
	it("drops the lowest-priority optional segment before a required run label", () => {
		const line = composeStatusLine(
			[
				{ id: "cwd", order: 3, priority: 10, render: () => "cwd=/very/long/path/that/should/drop" },
				{ id: "model", order: 1, priority: 80, render: () => "model=fast" },
				{ id: "run", order: 2, priority: 100, required: true, render: () => "RUNNING" },
			],
			28,
		);
		expect(line).toContain("RUNNING");
		expect(line).not.toContain("very/long/path");
	});

	it("omits a segment that throws", () => {
		const line = composeStatusLine(
			[
				{
					id: "boom",
					order: 1,
					priority: 50,
					render: () => {
						throw new Error("nope");
					},
				},
				{ id: "ok", order: 2, priority: 50, render: () => "ok" },
			],
			40,
		);
		expect(line).toBe("ok");
	});

	it("formats occupancy from accumulated usage", () => {
		const usage = accumulateAssistantUsage(emptyUsage(), {
			...emptyUsage(),
			input: 1000,
			output: 200,
			totalTokens: 1200,
		});
		expect(formatUsageOccupancy(usage, 128_000)).toContain("128k");
		expect(formatUsageOccupancy(usage, 128_000)).toContain("%");
	});
});
