import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, AgentEvent } from "@z-agent/agent";
import { describe, expect, it } from "vitest";
import { createRegistry } from "../src/command-registry.ts";
import { createExtensionHost } from "../src/extension-host.ts";
import { INTERACTIVE_COMMANDS } from "../src/interactive-commands.ts";

async function writeExt(dir: string, name: string, body: string): Promise<string> {
	const path = join(dir, name);
	await writeFile(path, body, "utf-8");
	return path;
}

describe("extension host", () => {
	it("registers a command and rejects a builtin shadow", async () => {
		const dir = await mkdtemp(join(tmpdir(), "z-ext-host-"));
		const path = await writeExt(
			dir,
			"demo.mjs",
			`export function createExtension(api) {
  api.registerCommand({
    name: "/hello",
    description: "hi",
    async run(ctx) { ctx.tui?.appendLine("hello"); return { kind: "continue" }; }
  });
  api.registerCommand({ name: "/status", description: "nope", async run() { return { kind: "continue" }; } });
}
`,
		);
		const registry = createRegistry(INTERACTIVE_COMMANDS);
		const host = createExtensionHost({ cwd: dir, registry });
		await host.load(path);
		expect(registry.lookup("/hello")?.source).toEqual({ extension: "demo.mjs" });
		expect(host.warnings.some((warning) => warning.includes("builtin_override"))).toBe(true);
	});

	it("loads a failing module as a warning and keeps hooks that throw local", async () => {
		const dir = await mkdtemp(join(tmpdir(), "z-ext-host-"));
		const bad = await writeExt(dir, "bad.mjs", "throw new Error('boom');\n");
		const noisy = await writeExt(
			dir,
			"noisy.mjs",
			`export function createExtension(api) {
  api.on("agent_start", () => { throw new Error("listener"); });
  return { beforeToolCall: async () => { throw new Error("before"); } };
}
`,
		);
		const registry = createRegistry(INTERACTIVE_COMMANDS);
		const host = createExtensionHost({ cwd: dir, registry });
		await host.load(bad);
		await host.load(noisy);
		expect(host.warnings.some((warning) => warning.includes("boom"))).toBe(true);
		expect(await host.hooks[0]?.beforeToolCall?.({} as never)).toBeUndefined();
		expect(host.warnings.some((warning) => warning.includes("beforeToolCall"))).toBe(true);

		let listener: ((event: AgentEvent) => Promise<void> | void) | undefined;
		const agent = {
			subscribe(next: (event: AgentEvent) => Promise<void> | void) {
				listener = next;
				return () => {};
			},
		} as unknown as Agent;
		host.bindAgent(agent);
		await listener?.({ type: "agent_start" });
		expect(host.warnings.some((warning) => warning.includes("listener"))).toBe(true);
	});

	it("registers tools, segments, and renderers with local degrade", async () => {
		const dir = await mkdtemp(join(tmpdir(), "z-ext-host-"));
		await mkdir(dir, { recursive: true });
		const path = await writeExt(
			dir,
			"ui.mjs",
			`export function createExtension(api) {
  api.registerTool({
    name: "ping",
    label: "ping",
    description: "ping",
    parameters: { parse: () => ({}), safeParse: () => ({ success: true, data: {} }) },
    execute: async () => ({ content: [{ type: "text", text: "pong" }], details: {} }),
  });
  api.registerStatusSegment({ id: "ext", order: 90, priority: 20, render: () => "ext-ok" });
  api.registerToolRenderer("ping", () => { throw new Error("render-fail"); });
}
`,
		);
		const registry = createRegistry(INTERACTIVE_COMMANDS);
		const host = createExtensionHost({ cwd: dir, registry });
		await host.load(path);
		expect(host.tools.map((tool) => tool.name)).toEqual(["ping"]);
		expect(host.extensionToolNames.has("ping")).toBe(true);
		expect(host.segments[0]?.render()).toBe("ext-ok");
		const snapshot = { toolCallId: "1", toolName: "ping", argsText: "{}", state: "success" as const };
		expect(host.toolRenderer(snapshot)).toBeUndefined();
		expect(host.warnings.filter((warning) => warning.includes("render-fail"))).toHaveLength(1);
		expect(host.toolRenderer(snapshot)).toBeUndefined();
		expect(host.warnings.filter((warning) => warning.includes("render-fail"))).toHaveLength(1);
	});

	it("does not re-enter the paint when a renderer fails during repaint", async () => {
		const dir = await mkdtemp(join(tmpdir(), "z-ext-host-"));
		const path = await writeExt(
			dir,
			"paint.mjs",
			`export function createExtension(api) {
  api.registerToolRenderer("ping", () => { throw new Error("paint-fail"); });
}
`,
		);
		const registry = createRegistry(INTERACTIVE_COMMANDS);
		let depth = 0;
		let maxDepth = 0;
		const host = createExtensionHost({
			cwd: dir,
			registry,
			onWarning: () => {
				depth += 1;
				maxDepth = Math.max(maxDepth, depth);
				host.toolRenderer({ toolCallId: "1", toolName: "ping", argsText: "{}", state: "success" });
				depth -= 1;
			},
		});
		await host.load(path);
		host.toolRenderer({ toolCallId: "1", toolName: "ping", argsText: "{}", state: "success" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(maxDepth).toBe(1);
	});
});
