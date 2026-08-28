import { mkdir, mkdtemp, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentContext } from "@z-agent/agent";
import { describe, expect, it } from "vitest";
import { createSession, messagesOnLeaf } from "../src/sessions.ts";
import { createSkillManager } from "../src/skill-manager.ts";

async function writeSkill(
	root: string,
	name: string,
	options: {
		description?: string;
		body?: string;
		keywords?: readonly string[];
		hidden?: boolean;
	} = {},
): Promise<string> {
	const directory = join(root, "skills", name);
	await mkdir(directory, { recursive: true });
	const keywords = options.keywords ?? [];
	const frontmatter = [
		"---",
		`name: ${name}`,
		`description: ${options.description ?? `Instructions for ${name}`}`,
		...(keywords.length > 0 ? ["metadata:", `  keywords: [${keywords.join(", ")}]`] : []),
		...(options.hidden ? ["disable-model-invocation: true"] : []),
		"---",
		"",
		options.body ?? `Apply ${name}.`,
		"",
	].join("\n");
	const path = join(directory, "SKILL.md");
	await writeFile(path, frontmatter, "utf8");
	return path;
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "z-skill-manager-"));
	const cwd = join(root, "project");
	const userPillow = join(root, "user-pillow");
	await mkdir(cwd, { recursive: true });
	await mkdir(userPillow, { recursive: true });
	return { root, cwd, userPillow, projectPillow: join(cwd, ".pillow") };
}

function context(messages: AgentContext["messages"] = []): AgentContext {
	return { systemPrompt: "base policy", messages, tools: [] };
}

describe("skill manager", () => {
	it("resolves project precedence and keeps an explicit request snapshot immutable across reload", async () => {
		const paths = await fixture();
		await writeSkill(paths.userPillow, "review", { body: "USER INSTRUCTIONS" });
		const projectPath = await writeSkill(paths.projectPillow, "review", { body: "PROJECT V1" });
		const session = createSession(paths.cwd);
		const manager = await createSkillManager({
			cwd: paths.cwd,
			userPillow: paths.userPillow,
			session,
			contextWindow: 128_000,
			maxTokens: 4_000,
		});

		expect(manager.getIndex().byName.get("review")?.source.scope).toBe("project");
		expect(manager.list("review")[0]).toMatchObject({ collision: true });
		const first = await manager.prepareSnapshot({ explicitName: "review", args: "focus on auth" });
		const trigger = manager.createInvocationMessage(first);
		const original = context([trigger]);
		const prepared = manager.prepareContext(original, first);
		expect(prepared.systemPrompt).toContain("PROJECT V1");
		expect(prepared.systemPrompt).toContain("focus on auth");
		expect(prepared.systemPrompt).not.toContain(paths.root);
		expect(prepared.messages).toMatchObject([
			{ role: "user", content: [{ type: "text", text: "Apply the explicitly invoked skill to this request." }] },
		]);
		expect(original.messages).toEqual([trigger]);
		expect(JSON.stringify(session.nodes)).not.toContain("focus on auth");
		expect(messagesOnLeaf(session)).toEqual([]);

		await writeFile(projectPath, "---\nname: review\ndescription: Review changed code\n---\n\nPROJECT V2\n", "utf8");
		const reloaded = await manager.reload();
		expect(reloaded.registryVersion).toBe(2);
		expect(manager.getState().active).toEqual([]);
		expect(manager.getState().stale.map((identity) => identity.name)).toEqual(["review"]);
		expect(manager.prepareContext(context([trigger]), first).systemPrompt).toContain("PROJECT V1");
		expect(first.registryVersion).toBe(1);
	});

	it("limits automatic activation, preserves explanations, and allows hidden explicit invocation", async () => {
		const paths = await fixture();
		for (const name of ["alpha", "beta", "gamma"]) {
			await writeSkill(paths.projectPillow, name, { keywords: [name], body: `${name} body` });
		}
		await writeSkill(paths.projectPillow, "private", { hidden: true, body: "PRIVATE BODY" });
		const manager = await createSkillManager({
			cwd: paths.cwd,
			userPillow: paths.userPillow,
			session: createSession(paths.cwd),
			contextWindow: 64_000,
		});

		const automatic = await manager.prepareSnapshot({ text: "alpha beta gamma" });
		expect(automatic.matched.activations).toHaveLength(2);
		expect(manager.getState().active).toHaveLength(2);
		expect(automatic.matched.matches.some((match) => match.exclusion === "turn_limit")).toBe(true);
		expect(manager.getState().active.some((identity) => identity.name === "private")).toBe(false);

		const explicit = await manager.prepareSnapshot({ explicitName: "private", args: "run privately" });
		expect(explicit.explicitInvocation?.body).toContain("PRIVATE BODY");
		expect(manager.getState().active.some((identity) => identity.name === "private")).toBe(true);
	});

	it("uses a model-safe display location for an external PILLOW_HOME", async () => {
		const paths = await fixture();
		await writeSkill(paths.userPillow, "portable", { body: "PORTABLE BODY" });
		const manager = await createSkillManager({
			cwd: paths.cwd,
			userPillow: paths.userPillow,
			session: createSession(paths.cwd),
			contextWindow: 64_000,
		});
		const snapshot = await manager.prepareSnapshot({ explicitName: "portable" });
		const prepared = manager.prepareContext(context([manager.createInvocationMessage(snapshot)]), snapshot);
		expect(prepared.systemPrompt).toContain("$PILLOW_HOME/skills/portable/SKILL.md");
		expect(prepared.systemPrompt).not.toContain(paths.root);
	});

	it("confines skill_read and rejects a stale skill", async () => {
		const paths = await fixture();
		const skillPath = await writeSkill(paths.projectPillow, "reader", { body: "Read references." });
		const skillDirectory = join(paths.projectPillow, "skills", "reader");
		await writeFile(join(skillDirectory, "notes.txt"), "inside", "utf8");
		const outside = join(paths.root, "outside.txt");
		await writeFile(outside, "outside", "utf8");
		await symlink(outside, join(skillDirectory, "escape.txt"));
		const session = createSession(paths.cwd);
		const manager = await createSkillManager({
			cwd: paths.cwd,
			userPillow: paths.userPillow,
			session,
			contextWindow: 64_000,
		});
		await manager.activate("reader", "explicit");
		const tool = manager.createReadTool();

		await expect(tool.execute("read-1", { skill: "reader", path: "notes.txt" })).resolves.toMatchObject({
			content: [{ type: "text", text: "inside" }],
			details: { skill: "reader", path: "notes.txt" },
		});
		await expect(tool.execute("read-2", { skill: "reader", path: "../outside.txt" })).rejects.toThrow(
			"parent traversal",
		);
		await expect(tool.execute("read-3", { skill: "reader", path: "escape.txt" })).rejects.toThrow(
			"escapes skill root",
		);

		await writeFile(skillPath, "---\nname: reader\ndescription: Changed\n---\n\nchanged\n", "utf8");
		await manager.reload();
		await expect(tool.execute("read-4", { skill: "reader" })).rejects.toThrow("stale");

		const resumed = await createSkillManager({
			cwd: paths.cwd,
			userPillow: paths.userPillow,
			session,
			contextWindow: 64_000,
		});
		expect(resumed.getState().stale.map((identity) => identity.name)).toContain("reader");
	});

	it("fails explicitly when skills exist but the model context window is unknown", async () => {
		const paths = await fixture();
		await writeSkill(paths.projectPillow, "review");
		const manager = await createSkillManager({
			cwd: paths.cwd,
			userPillow: paths.userPillow,
			session: createSession(paths.cwd),
		});
		const snapshot = await manager.prepareSnapshot({ text: "review" });
		expect(() => manager.prepareContext(context(), snapshot)).toThrow("finite, positive context window");
	});

	it("shows removed stale skills and clears them through an explicit disable", async () => {
		const paths = await fixture();
		const skillPath = await writeSkill(paths.projectPillow, "removed", { body: "v1" });
		const manager = await createSkillManager({
			cwd: paths.cwd,
			userPillow: paths.userPillow,
			session: createSession(paths.cwd),
			contextWindow: 64_000,
		});
		await manager.activate("removed", "explicit");
		await unlink(skillPath);
		await manager.reload();
		const status = manager.list("removed")[0];
		expect(status).toMatchObject({ name: "removed", stale: true, location: "(unavailable)" });
		expect(status?.location).not.toContain(paths.root);
		const disabled = await manager.deactivate("removed", "command");
		expect(disabled.ok).toBe(true);
		expect(manager.getState()).toMatchObject({ active: [], stale: [], manualOffNames: ["removed"] });
	});

	it("refreshes the snapshot after state-only commands and respects manual-off for all", async () => {
		const paths = await fixture();
		await writeSkill(paths.projectPillow, "one", { body: "ONE" });
		await writeSkill(paths.projectPillow, "two", { body: "TWO" });
		const manager = await createSkillManager({
			cwd: paths.cwd,
			userPillow: paths.userPillow,
			session: createSession(paths.cwd),
			contextWindow: 64_000,
		});
		await manager.activate("one", "explicit");
		await manager.deactivate("one", "command");
		const results = await manager.activateAll();
		expect(results.every((result) => result.descriptor?.metadata.name !== "one")).toBe(true);
		expect(manager.getState().active.map((identity) => identity.name)).toEqual(["two"]);
		expect(manager.getSnapshot().state.active.map((identity) => identity.name)).toEqual(["two"]);
	});

	it("does not let batch activation silently rebind a stale identity", async () => {
		const paths = await fixture();
		const skillPath = await writeSkill(paths.projectPillow, "changed", { body: "VERSION ONE" });
		const manager = await createSkillManager({
			cwd: paths.cwd,
			userPillow: paths.userPillow,
			session: createSession(paths.cwd),
			contextWindow: 64_000,
		});
		await manager.activate("changed", "explicit");
		await writeFile(skillPath, "---\nname: changed\ndescription: Changed\n---\n\nVERSION TWO\n", "utf8");
		await manager.reload();
		expect(manager.getState().stale.map((identity) => identity.name)).toEqual(["changed"]);

		const results = await manager.activateAll();
		expect(results).toEqual([]);
		expect(manager.getState().stale.map((identity) => identity.name)).toEqual(["changed"]);
		expect(manager.getState().active).toEqual([]);
	});

	it("applies a new context budget to later snapshots only", async () => {
		const paths = await fixture();
		await writeSkill(paths.projectPillow, "review", { body: "PROJECT V1" });
		const manager = await createSkillManager({
			cwd: paths.cwd,
			userPillow: paths.userPillow,
			session: createSession(paths.cwd),
			contextWindow: 64_000,
			maxTokens: 2_000,
		});
		const before = await manager.prepareSnapshot({ text: "review" });
		expect(before.budget.contextWindow).toBe(64_000);
		expect(before.budget.outputReserve).toBe(2_000);
		manager.setBudget({ contextWindow: 200_000, maxTokens: 8_192 });
		expect(manager.getSnapshot().budget.contextWindow).toBe(200_000);
		expect(manager.getSnapshot().budget.outputReserve).toBe(8_192);
		expect(before.budget.contextWindow).toBe(64_000);
		expect(before.budget.outputReserve).toBe(2_000);
		const after = await manager.prepareSnapshot({ text: "review" });
		expect(after.budget.contextWindow).toBe(200_000);
		expect(after.budget.outputReserve).toBe(8_192);
	});
});
