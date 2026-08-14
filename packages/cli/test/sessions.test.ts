import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	appendMessage,
	branch,
	createSession,
	latestSessionId,
	loadSession,
	messagesOnLeaf,
	rootToLeaf,
	saveSession,
} from "../src/sessions.ts";

describe("session tree", () => {
	it("appends, branches, and reloads", async () => {
		const root = await mkdtemp(join(tmpdir(), "z-sess-"));
		const session = createSession("/tmp/proj");
		appendMessage(session, { role: "user", content: [{ type: "text", text: "a" }], timestamp: 1 });
		const mid = appendMessage(session, { role: "user", content: [{ type: "text", text: "b" }], timestamp: 2 });
		appendMessage(session, { role: "user", content: [{ type: "text", text: "c" }], timestamp: 3 });
		expect(messagesOnLeaf(session)).toHaveLength(3);

		const branched = branch(session, mid.id);
		expect(
			rootToLeaf(branched).map((node) =>
				node.message && "content" in node.message ? JSON.stringify(node.message.content) : "",
			),
		).toHaveLength(2);

		await saveSession(branched, root);
		const id = await latestSessionId("/tmp/proj", root);
		expect(id).toBe(session.header.id);
		const loadedBranch = await loadSession("/tmp/proj", session.header.id, root);
		expect(messagesOnLeaf(loadedBranch)).toHaveLength(2);
		expect(loadedBranch.leafId).toBe(mid.id);

		await saveSession(session, root);
		const loaded = await loadSession("/tmp/proj", session.header.id, root);
		expect(messagesOnLeaf(loaded)).toHaveLength(3);
	});
});
