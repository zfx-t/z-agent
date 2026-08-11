import { describe, expect, it } from "vitest";
import { AGENT_PACKAGE, composeAgentEventSinks, createAgentEventCollector, emitAgentEvent } from "../src/index.ts";

describe("@z-agent/agent", () => {
	it("exports package identity", () => {
		expect(AGENT_PACKAGE).toBe("@z-agent/agent");
	});

	it("re-exports emit surface", async () => {
		expect(typeof createAgentEventCollector).toBe("function");
		expect(typeof composeAgentEventSinks).toBe("function");
		expect(typeof emitAgentEvent).toBe("function");
		const c = createAgentEventCollector();
		await emitAgentEvent(c.sink, { type: "agent_start" });
		expect(c.types()).toEqual(["agent_start"]);
	});
});
