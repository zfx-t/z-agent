import { describe, expect, it } from "vitest";
import { AGENT_PACKAGE } from "../src/index.ts";

describe("@z-agent/agent", () => {
	it("exports package identity", () => {
		expect(AGENT_PACKAGE).toBe("@z-agent/agent");
	});
});
