import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	appendCompaction,
	appendMessage,
	branch,
	createSession,
	formatCheckpointRow,
	inspectSession,
	latestSessionId,
	listCheckpoints,
	loadSession,
	messagesOnLeaf,
	resetSessionBranch,
	rootToLeaf,
	type SessionRecord,
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
				node.type === "message" && "content" in node.message ? JSON.stringify(node.message.content) : "",
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

	it("projects compaction and reset boundaries while retaining append-only history", () => {
		const session = createSession("/tmp/proj");
		appendMessage(session, { role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 });
		appendCompaction(session, "summary");
		appendMessage(session, { role: "user", content: [{ type: "text", text: "tail" }], timestamp: 2 });

		expect(messagesOnLeaf(session)).toMatchObject([
			{ role: "user", content: [{ type: "text", text: "summary" }] },
			{ role: "user", content: [{ type: "text", text: "tail" }] },
		]);
		const retainedNodes = session.nodes.length;
		resetSessionBranch(session);
		expect(messagesOnLeaf(session)).toEqual([]);
		expect(session.nodes).toHaveLength(retainedNodes);
	});

	it("lists checkpoints with live-path and off-path markers without merging siblings", () => {
		const session = createSession("/tmp/proj");
		const first = appendMessage(session, { role: "user", content: [{ type: "text", text: "a" }], timestamp: 1 });
		const live = appendMessage(session, { role: "user", content: [{ type: "text", text: "b" }], timestamp: 2 });
		const side = branch(session, first.id);
		appendMessage(side, { role: "user", content: [{ type: "text", text: "c" }], timestamp: 3 });
		session.nodes = side.nodes;
		session.leafId = live.id;

		const rows = listCheckpoints(session).map(formatCheckpointRow);
		expect(rows).toEqual(["+ user: a", "*   user: b", ".   user: c"]);
		expect(messagesOnLeaf(session).map(userText)).toEqual(["a", "b"]);
		expect(messagesOnLeaf(branch(session, side.nodes[2]?.id ?? "")).map(userText)).toEqual(["a", "c"]);
	});

	it("refuses cycles, missing parents, missing leaves, and duplicate ids", () => {
		const cycle = createSession("/tmp/proj");
		cycle.nodes = [messageNode("b", "c", "b"), messageNode("c", "b", "c")];
		cycle.leafId = "c";
		expect(inspectSession(cycle)).toEqual({ ok: false, reason: "cycle", detail: "b" });
		expect(rootToLeaf(cycle).map((node) => node.id)).toEqual(["b", "c"]);

		const missingParent: SessionRecord = {
			...createSession("/tmp/proj"),
			nodes: [messageNode("child", "ghost", "x")],
			leafId: "child",
		};
		expect(inspectSession(missingParent)).toEqual({ ok: false, reason: "missing_parent", detail: "child" });

		const missingLeaf: SessionRecord = {
			...createSession("/tmp/proj"),
			nodes: [messageNode("a", null, "a")],
			leafId: "nope",
		};
		expect(inspectSession(missingLeaf)).toEqual({ ok: false, reason: "missing_leaf", detail: "nope" });

		const duplicate: SessionRecord = {
			...createSession("/tmp/proj"),
			nodes: [messageNode("a", null, "a"), messageNode("a", null, "b")],
			leafId: "a",
		};
		expect(inspectSession(duplicate)).toEqual({ ok: false, reason: "duplicate_id", detail: "a" });
		expect(listCheckpoints(cycle)).toEqual([]);
	});
});

function userText(message: { role?: string; content?: unknown }): string {
	if (!("content" in message) || !Array.isArray(message.content)) {
		return "";
	}
	const block = message.content[0];
	return typeof block === "object" && block && "text" in block ? String(block.text) : "";
}

function messageNode(id: string, parentId: string | null, text: string): SessionRecord["nodes"][number] {
	return {
		id,
		parentId,
		type: "message",
		createdAt: 1,
		message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
	};
}
