import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BeforeToolCallContext } from "@z-agent/agent";
import { describe, expect, it } from "vitest";
import { composeBefore, discoverExtensionPaths, loadExtension } from "../src/extensions.ts";

describe("extensions", () => {
	it("loads a module and can block after the confirm gate", async () => {
		const dir = await mkdtemp(join(tmpdir(), "z-ext-"));
		const file = join(dir, "ext.mjs");
		await writeFile(
			file,
			"export function createExtension() { return { beforeToolCall: async () => ({ block: true, reason: 'ext' }) }; }\n",
			"utf-8",
		);
		const ext = await loadExtension(file, dir);
		const composed = composeBefore(async () => undefined, [ext]);
		const result = await composed({
			assistantMessage: {
				role: "assistant",
				content: [],
				api: "t",
				provider: "t",
				model: "t",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 1,
			},
			toolCall: { type: "toolCall", id: "1", name: "bash", arguments: {} },
			args: {},
			context: { systemPrompt: "", messages: [] },
		} satisfies BeforeToolCallContext);
		expect(result).toEqual({ block: true, reason: "ext" });
	});

	it("discovers extension modules under cwd .pillow/extensions", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "z-ext-disc-"));
		const dir = join(cwd, ".pillow", "extensions");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "hook.mjs"), "export function createExtension() { return {}; }\n", "utf-8");
		const paths = await discoverExtensionPaths(cwd);
		expect(paths.some((path) => path.endsWith("hook.mjs"))).toBe(true);
	});
});
