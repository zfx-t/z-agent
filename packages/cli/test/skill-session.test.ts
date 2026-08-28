import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	appendCompaction,
	appendMessage,
	appendSkillActivation,
	appendSkillDeactivation,
	appendSkillMode,
	branch,
	createSession,
	loadSession,
	messagesOnLeaf,
	rootToLeaf,
	saveSession,
	sessionDirForCwd,
	skillStateOnLeaf,
} from "../src/sessions.ts";

const activationInput = {
	type: "skill_activation" as const,
	schemaVersion: 1 as const,
	skillName: "review",
	canonicalPath: "/skills/review/SKILL.md",
	sourceScope: "project" as const,
	sourceKind: "conventional" as const,
	contentHash: "sha256:review-v1",
	origin: "automatic" as const,
};

describe("skill session controls", () => {
	it("projects branch-local skill state without exposing controls as messages", () => {
		const session = createSession("/tmp/project");
		appendMessage(session, { role: "user", content: [{ type: "text", text: "review this" }], timestamp: 1 });
		const activation = appendSkillActivation(session, activationInput);
		appendSkillMode(session, "full");
		appendSkillDeactivation(session, {
			type: "skill_deactivation",
			schemaVersion: 1,
			skillName: "review",
			canonicalPath: activationInput.canonicalPath,
			origin: "explicit",
		});
		appendMessage(session, { role: "user", content: [{ type: "text", text: "continue" }], timestamp: 2 });

		expect(messagesOnLeaf(session)).toHaveLength(2);
		expect(skillStateOnLeaf(session)).toMatchObject({
			active: [],
			manualOffNames: ["review"],
			mode: "full",
		});

		const atActivation = branch(session, activation.id);
		expect(rootToLeaf(atActivation).at(-1)).toEqual(activation);
		expect(skillStateOnLeaf(atActivation)).toMatchObject({
			active: [
				{
					name: "review",
					canonicalPath: activationInput.canonicalPath,
					contentHash: activationInput.contentHash,
					sourceScope: "project",
					sourceKind: "conventional",
				},
			],
			manualOffNames: [],
			mode: "progressive",
		});
	});

	it("loads legacy JSONL with the default skill state", async () => {
		const root = await mkdtemp(join(tmpdir(), "z-legacy-sess-"));
		const cwd = "/tmp/legacy-project";
		const dir = sessionDirForCwd(cwd, root);
		await mkdir(dir, { recursive: true });
		const message = {
			id: "message-1",
			parentId: null,
			type: "message",
			createdAt: 1,
			message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
		};
		const compaction = {
			id: "compaction-1",
			parentId: message.id,
			type: "compaction",
			createdAt: 2,
			summary: "older context",
		};
		const label = {
			id: "label-1",
			parentId: compaction.id,
			type: "label",
			createdAt: 3,
		};
		const lines = [
			{ type: "header", id: "legacy", cwd, createdAt: 0, leafId: label.id },
			message,
			compaction,
			label,
		].map((value) => JSON.stringify(value));
		await writeFile(join(dir, "legacy.jsonl"), `${lines.join("\n")}\n`, "utf8");

		const loaded = await loadSession(cwd, "legacy", root);
		expect(messagesOnLeaf(loaded)).toHaveLength(1);
		expect(skillStateOnLeaf(loaded)).toMatchObject({
			active: [],
			manualOffNames: [],
			mode: "progressive",
			stale: [],
		});
	});

	it("round-trips every skill control field and parent link", async () => {
		const root = await mkdtemp(join(tmpdir(), "z-skill-sess-"));
		const session = createSession("/tmp/round-trip-project");
		const activation = appendSkillActivation(session, { ...activationInput, origin: "command" });
		const mode = appendSkillMode(session, "index");
		const deactivation = appendSkillDeactivation(session, {
			type: "skill_deactivation",
			schemaVersion: 1,
			skillName: activation.skillName,
			canonicalPath: activation.canonicalPath,
			origin: "reload",
		});
		appendCompaction(session, "summary that must not replace controls");

		const path = await saveSession(session, root);
		const loaded = await loadSession(session.header.cwd, session.header.id, root);
		const controls = loaded.nodes.filter(
			(node) => node.type === "skill_activation" || node.type === "skill_mode" || node.type === "skill_deactivation",
		);

		expect(controls).toEqual([activation, mode, deactivation]);
		expect(mode.parentId).toBe(activation.id);
		expect(deactivation.parentId).toBe(mode.id);
		expect(controls.every((node) => node.schemaVersion === 1)).toBe(true);
		expect(await readFile(path, "utf8")).toContain('"schemaVersion":1');
		expect(rootToLeaf(loaded).filter((node) => node.type.startsWith("skill_"))).toEqual(controls);
	});
});
