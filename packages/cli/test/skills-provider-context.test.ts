import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentContext } from "@z-agent/agent";
import { type AssistantMessage, createAssistantMessageEventStream, emptyUsage, type StreamFn } from "@z-agent/ai";
import { describe, expect, it } from "vitest";
import { createSession } from "../src/sessions.ts";
import { createSkillManager } from "../src/skill-manager.ts";

async function makeSkill() {
	const root = await mkdtemp(join(tmpdir(), "z-skills-context-"));
	const cwd = join(root, "project");
	const userPillow = join(root, "user");
	const directory = join(cwd, ".pillow", "skills", "review");
	await mkdir(directory, { recursive: true });
	await mkdir(userPillow, { recursive: true });
	const path = join(directory, "SKILL.md");
	await writeFile(path, "---\nname: review\ndescription: Review code\n---\n\nBODY ONE\n", "utf8");
	return { root, cwd, userPillow, path };
}

function response(modelId: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "test",
		provider: "test",
		model: modelId,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function oneShotStream(capture: (context: AgentContext) => void): StreamFn {
	return (model, context) => {
		capture(context as AgentContext);
		const stream = createAssistantMessageEventStream();
		const final = response(model.id);
		stream.push({ type: "start", partial: { ...final, content: [], stopReason: "pending" } });
		stream.push({ type: "done", reason: "stop", message: final });
		stream.end(final);
		return stream;
	};
}

describe("skills provider context integration", () => {
	it("injects explicit body only into provider context and keeps transcript clean", async () => {
		const fixture = await makeSkill();
		const manager = await createSkillManager({
			cwd: fixture.cwd,
			userPillow: fixture.userPillow,
			session: createSession(fixture.cwd),
			contextWindow: 64_000,
		});
		const snapshot = await manager.prepareSnapshot({ explicitName: "review", args: "security" });
		const invocation = manager.createInvocationMessage(snapshot);
		let seen: AgentContext | undefined;
		const agent = new Agent({
			streamFn: oneShotStream((context) => {
				seen = context;
			}),
			prepareContext: (context) => manager.prepareContext(context, snapshot),
			initialState: {
				model: {
					id: "test",
					name: "test",
					api: "test",
					provider: "test",
					baseUrl: "http://localhost",
					contextWindow: 64_000,
				},
				systemPrompt: "BASE",
				messages: [invocation],
			},
		});

		await agent.continue();
		expect(seen?.systemPrompt).toContain("BODY ONE");
		expect(seen?.systemPrompt).toContain("security");
		expect(seen?.systemPrompt).not.toContain(fixture.root);
		expect(seen?.messages).toMatchObject([
			{ role: "user", content: [{ type: "text", text: "Apply the explicitly invoked skill to this request." }] },
		]);
		expect(JSON.stringify(agent.state.messages)).not.toContain("BODY ONE");
		expect(JSON.stringify(agent.state.messages)).not.toContain("security");
	});

	it("keeps a captured snapshot stable while the registry reloads", async () => {
		const fixture = await makeSkill();
		const manager = await createSkillManager({
			cwd: fixture.cwd,
			userPillow: fixture.userPillow,
			session: createSession(fixture.cwd),
			contextWindow: 64_000,
		});
		const first = await manager.prepareSnapshot({ explicitName: "review", args: "first" });
		await writeFile(fixture.path, "---\nname: review\ndescription: Review code\n---\n\nBODY TWO\n", "utf8");
		await manager.reload();
		const oldContext = manager.prepareContext(
			{ systemPrompt: "BASE", messages: [manager.createInvocationMessage(first)], tools: [] },
			first,
		);
		expect(oldContext.systemPrompt).toContain("BODY ONE");
		expect(oldContext.systemPrompt).not.toContain("BODY TWO");
		const next = await manager.prepareSnapshot({ explicitName: "review", args: "second" });
		const nextContext = manager.prepareContext(
			{ systemPrompt: "BASE", messages: [manager.createInvocationMessage(next)], tools: [] },
			next,
		);
		expect(nextContext.systemPrompt).toContain("BODY TWO");
	});
});
