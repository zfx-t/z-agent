import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
} from "@z-agent/ai";

/**
 * Rebuild an event stream from a persisted final AssistantMessage:
 * `start` → `done`/`error` → `end`. No synthetic deltas (ADR-0030).
 */
export function replayAssistantMessage(message: AssistantMessage): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "start", partial: message });
	const reason = message.stopReason;
	if (reason === "stop" || reason === "length" || reason === "toolUse") {
		stream.push({ type: "done", reason, message });
	} else {
		stream.push({ type: "error", reason: reason === "aborted" ? "aborted" : "error", error: message });
	}
	stream.end(message);
	return stream;
}
