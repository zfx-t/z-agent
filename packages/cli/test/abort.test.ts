import type { Agent } from "@z-agent/agent";
import { describe, expect, it } from "vitest";
import { SigintAbort } from "../src/abort.ts";

function fakeAgent(isStreaming: boolean): Agent & { abortCalls: number } {
	const agent = {
		abortCalls: 0,
		state: { isStreaming },
		abort() {
			agent.abortCalls += 1;
		},
	};
	return agent as unknown as Agent & { abortCalls: number };
}

describe("SigintAbort", () => {
	it("aborts a streaming agent on the first SIGINT and exits 130 on the second", () => {
		const agent = fakeAgent(true);
		const exits: number[] = [];
		const session = new SigintAbort(
			() => agent,
			(code) => {
				exits.push(code);
			},
		);
		session.handleSigint();
		expect(agent.abortCalls).toBe(1);
		expect(exits).toEqual([]);
		session.handleSigint();
		expect(exits).toEqual([130]);
	});

	it("exits 0 when idle", () => {
		const agent = fakeAgent(false);
		const exits: number[] = [];
		const session = new SigintAbort(
			() => agent,
			(code) => {
				exits.push(code);
			},
		);
		session.handleSigint();
		expect(agent.abortCalls).toBe(0);
		expect(exits).toEqual([0]);
	});
});
