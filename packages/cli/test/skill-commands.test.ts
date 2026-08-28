import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, AgentEvent } from "@z-agent/agent";
import { describe, expect, it, vi } from "vitest";
import { createSession } from "../src/sessions.ts";
import { SkillInputCoordinator } from "../src/skill-commands.ts";
import { createSkillManager } from "../src/skill-manager.ts";

async function setupSkill(body = "VERSION ONE") {
	const root = await mkdtemp(join(tmpdir(), "z-skill-commands-"));
	const cwd = join(root, "project");
	const userPillow = join(root, "user");
	const skillDirectory = join(cwd, ".pillow", "skills", "review");
	await mkdir(skillDirectory, { recursive: true });
	await mkdir(userPillow, { recursive: true });
	const skillPath = join(skillDirectory, "SKILL.md");
	await writeFile(skillPath, `---\nname: review\ndescription: Review code\n---\n\n${body}\n`, "utf8");
	const manager = await createSkillManager({
		cwd,
		userPillow,
		session: createSession(cwd),
		contextWindow: 64_000,
	});
	return { root, cwd, skillPath, manager };
}

function fakeAgent() {
	let listener: ((event: AgentEvent, signal: AbortSignal) => Promise<void> | void) | undefined;
	const steer = vi.fn();
	const agent = {
		steer,
		subscribe(next: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void) {
			listener = next;
			return () => {
				listener = undefined;
			};
		},
	} as unknown as Agent;
	return {
		agent,
		steer,
		async turnEnd() {
			await listener?.({ type: "turn_end", message: {} as never, toolResults: [] }, new AbortController().signal);
		},
	};
}

describe("skill input coordinator", () => {
	it("runs queued reload before a later explicit invocation and preserves the old snapshot", async () => {
		const fixture = await setupSkill();
		const oldSnapshot = await fixture.manager.prepareSnapshot({ explicitName: "review", args: "old args" });
		const oldTrigger = fixture.manager.createInvocationMessage(oldSnapshot);
		await writeFile(fixture.skillPath, "---\nname: review\ndescription: Review code\n---\n\nVERSION TWO\n", "utf8");
		const fake = fakeAgent();
		const output: string[] = [];
		const coordinator = new SkillInputCoordinator({
			agent: fake.agent,
			manager: fixture.manager,
			write: (_level, text) => output.push(text),
		});
		coordinator.subscribe();

		coordinator.enqueueDuringRun("/reload");
		coordinator.enqueueDuringRun("/review new args");
		await fake.turnEnd();

		expect(fixture.manager.getIndex().version).toBe(2);
		expect(fake.steer).toHaveBeenCalledOnce();
		expect(fake.steer.mock.calls[0]?.[0]).toMatchObject({ role: "skillInvocation", skillName: "review" });
		expect(fixture.manager.getSnapshot().explicitInvocation?.body).toContain("VERSION TWO");
		expect(fixture.manager.getSnapshot().explicitInvocation?.args).toBe("new args");
		expect(
			fixture.manager.prepareContext({ systemPrompt: "base", messages: [oldTrigger], tools: [] }, oldSnapshot)
				.systemPrompt,
		).toContain("VERSION ONE");
		expect(output.findIndex((line) => line.startsWith("[reload]"))).toBeLessThan(
			output.findIndex((line) => line.includes("activated for this request")),
		);
	});

	it("keeps non-skill built-ins queued until idle without overtaking later text", async () => {
		const fixture = await setupSkill();
		const fake = fakeAgent();
		const coordinator = new SkillInputCoordinator({ agent: fake.agent, manager: fixture.manager });
		coordinator.subscribe();
		coordinator.enqueueDuringRun("/reset");
		coordinator.enqueueDuringRun("review this later");

		await fake.turnEnd();

		expect(fake.steer).not.toHaveBeenCalled();
		expect(coordinator.takePendingAfterIdle()).toBe("/reset");
		expect(coordinator.takePendingAfterIdle()).toBe("review this later");
	});

	it("passes unknown slash text through and renders skill status without canonical paths", async () => {
		const fixture = await setupSkill();
		const fake = fakeAgent();
		const output: string[] = [];
		const coordinator = new SkillInputCoordinator({
			agent: fake.agent,
			manager: fixture.manager,
			write: (_level, text) => output.push(text),
		});

		const passthrough = await coordinator.submit("/not-a-command keep this");
		expect(passthrough).toMatchObject({ kind: "request", message: { role: "user" } });
		expect(passthrough.kind === "request" && passthrough.message).toMatchObject({
			content: [{ type: "text", text: "/not-a-command keep this" }],
		});

		expect(await coordinator.submit("/skills rev")).toEqual({ kind: "handled" });
		expect(output.some((line) => line.includes("review [inactive]"))).toBe(true);
		expect(output.join("\n")).not.toContain(fixture.root);
	});
});
