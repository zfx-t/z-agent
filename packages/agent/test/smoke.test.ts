import { describe, expect, it } from "vitest";
import {
	AGENT_PACKAGE,
	Agent,
	agentLoop,
	agentLoopContinue,
	composeAgentEventSinks,
	createAgentEventCollector,
	emitAgentEvent,
	runAgentLoop,
	runAgentLoopContinue,
	runLoop,
	streamAssistant,
} from "../src/index.ts";

describe("@z-agent/agent", () => {
	it("exports package identity", () => {
		expect(AGENT_PACKAGE).toBe("@z-agent/agent");
	});

	it("re-exports emit + loop + Agent shell surface", async () => {
		expect(typeof createAgentEventCollector).toBe("function");
		expect(typeof composeAgentEventSinks).toBe("function");
		expect(typeof emitAgentEvent).toBe("function");
		expect(typeof runAgentLoop).toBe("function");
		expect(typeof runAgentLoopContinue).toBe("function");
		expect(typeof agentLoop).toBe("function");
		expect(typeof agentLoopContinue).toBe("function");
		expect(typeof runLoop).toBe("function");
		expect(typeof streamAssistant).toBe("function");
		expect(typeof Agent).toBe("function");
		const c = createAgentEventCollector();
		await emitAgentEvent(c.sink, { type: "agent_start" });
		expect(c.types()).toEqual(["agent_start"]);
	});
});
