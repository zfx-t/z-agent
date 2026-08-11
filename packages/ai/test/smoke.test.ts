import { describe, expect, it } from "vitest";
import {
	AI_PACKAGE,
	createFauxStream,
	createOpenAIResponsesStream,
	EventStream,
	emptyUsage,
	fauxAssistantMessage,
	streamOpenAIResponses,
} from "../src/index.ts";

describe("@z-agent/ai", () => {
	it("exports package identity", () => {
		expect(AI_PACKAGE).toBe("@z-agent/ai");
	});

	it("re-exports protocol surface", () => {
		expect(typeof EventStream).toBe("function");
		expect(typeof createFauxStream).toBe("function");
		expect(typeof createOpenAIResponsesStream).toBe("function");
		expect(typeof streamOpenAIResponses).toBe("function");
		expect(emptyUsage().totalTokens).toBe(0);
		expect(fauxAssistantMessage("x").role).toBe("assistant");
	});
});
