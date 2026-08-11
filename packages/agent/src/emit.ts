/**
 * Agent event sink and small emit helpers.
 *
 * The loop (later PRs) awaits the sink for each event in semantic order.
 * Helpers here support composition and test collection only — no runLoop.
 */

import type { AgentEvent, AgentEventType } from "./types.ts";

/**
 * Async sink the loop uses to publish lifecycle events.
 * May be sync or async; the loop always awaits the result.
 */
export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/** Await a single event delivery to a sink. */
export async function emitAgentEvent(sink: AgentEventSink, event: AgentEvent): Promise<void> {
	await sink(event);
}

/**
 * Sequential fan-out: each sink is awaited in registration order before the next.
 * Empty list is a no-op sink.
 */
export function composeAgentEventSinks(sinks: readonly AgentEventSink[]): AgentEventSink {
	// Snapshot so mid-fan-out mutation of the caller's array cannot change which sinks run.
	const snapshot = sinks.slice();
	return async (event) => {
		for (const sink of snapshot) {
			await sink(event);
		}
	};
}

/** Mutable collector for tests and lightweight inspection. */
export interface AgentEventCollector {
	/** Events received so far, in delivery order. */
	readonly events: readonly AgentEvent[];
	/** Sink that appends to {@link events}. */
	readonly sink: AgentEventSink;
	/** Discriminants of collected events, in order. */
	types(): AgentEventType[];
	/** Drop all collected events. */
	clear(): void;
}

/**
 * Create a collecting sink that records events in order.
 * Useful for unit tests of emit helpers and (later) runLoop ordering.
 */
export function createAgentEventCollector(): AgentEventCollector {
	const events: AgentEvent[] = [];
	return {
		get events() {
			return events;
		},
		sink(event) {
			events.push(event);
		},
		types() {
			return events.map((e) => e.type);
		},
		clear() {
			events.length = 0;
		},
	};
}
