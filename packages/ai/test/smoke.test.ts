import { describe, expect, it } from "vitest";
import { AI_PACKAGE } from "../src/index.ts";

describe("@z-agent/ai", () => {
	it("exports package identity", () => {
		expect(AI_PACKAGE).toBe("@z-agent/ai");
	});
});
