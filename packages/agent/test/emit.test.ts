import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentMessage } from "../src/index.ts";
import {
	type AgentEventSink,
	composeAgentEventSinks,
	createAgentEventCollector,
	emitAgentEvent,
} from "../src/index.ts";

function userMsg(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 0 };
}

describe("createAgentEventCollector", () => {
	it("records events in delivery order", async () => {
		const collector = createAgentEventCollector();
		const messages: AgentMessage[] = [userMsg("hi")];

		await emitAgentEvent(collector.sink, { type: "agent_start" });
		await emitAgentEvent(collector.sink, { type: "turn_start" });
		await emitAgentEvent(collector.sink, {
			type: "message_start",
			message: messages[0]!,
		});
		await emitAgentEvent(collector.sink, {
			type: "message_end",
			message: messages[0]!,
		});
		await emitAgentEvent(collector.sink, {
			type: "turn_end",
			message: messages[0]!,
			toolResults: [],
		});
		await emitAgentEvent(collector.sink, {
			type: "agent_end",
			messages,
		});

		expect(collector.types()).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"turn_end",
			"agent_end",
		]);
		expect(collector.events).toHaveLength(6);
		expect(collector.events[0]).toEqual({ type: "agent_start" });
		expect(collector.events[5]).toEqual({ type: "agent_end", messages });
	});

	it("clear() drops collected events", async () => {
		const collector = createAgentEventCollector();
		await emitAgentEvent(collector.sink, { type: "agent_start" });
		expect(collector.events).toHaveLength(1);
		collector.clear();
		expect(collector.events).toHaveLength(0);
		expect(collector.types()).toEqual([]);
	});
});

describe("composeAgentEventSinks", () => {
	it("awaits sinks in registration order", async () => {
		const order: string[] = [];
		const a: AgentEventSink = async () => {
			order.push("a-start");
			await Promise.resolve();
			order.push("a-end");
		};
		const b: AgentEventSink = () => {
			order.push("b");
		};
		const composed = composeAgentEventSinks([a, b]);
		await emitAgentEvent(composed, { type: "agent_start" });
		expect(order).toEqual(["a-start", "a-end", "b"]);
	});

	it("empty compose is a no-op", async () => {
		const composed = composeAgentEventSinks([]);
		await expect(emitAgentEvent(composed, { type: "agent_start" })).resolves.toBeUndefined();
	});

	it("fans out the same event payload", async () => {
		const c1 = createAgentEventCollector();
		const c2 = createAgentEventCollector();
		const composed = composeAgentEventSinks([c1.sink, c2.sink]);
		const event: AgentEvent = {
			type: "tool_execution_start",
			toolCallId: "c1",
			toolName: "echo",
			args: { x: 1 },
		};
		await emitAgentEvent(composed, event);
		expect(c1.events[0]).toEqual(event);
		expect(c2.events[0]).toEqual(event);
	});

	it("snapshots sinks so mid-fan-out array mutation is ignored", async () => {
		const order: string[] = [];
		const sinks: AgentEventSink[] = [];
		sinks.push(async () => {
			order.push("a");
			sinks.push(async () => {
				order.push("late");
			});
		});
		sinks.push(() => {
			order.push("b");
		});
		const composed = composeAgentEventSinks(sinks);
		await emitAgentEvent(composed, { type: "agent_start" });
		expect(order).toEqual(["a", "b"]);
	});
});
