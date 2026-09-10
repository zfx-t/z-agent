import { describe, expect, it, vi } from "vitest";
import { CommandRegistry, createRegistry, findCommand, runCommand } from "../src/command-registry.ts";
import type { InteractiveCommand } from "../src/command-types.ts";
import { INTERACTIVE_COMMANDS } from "../src/interactive-commands.ts";
import { parseSlashInput } from "../src/slash.ts";

function stubCommand(name: string, extras: Partial<InteractiveCommand> = {}): InteractiveCommand {
	return {
		name,
		description: name,
		source: extras.source ?? "builtin",
		run: extras.run ?? (async () => ({ kind: "continue" })),
		...extras,
	};
}

describe("command registry", () => {
	it("looks up aliases and keeps built-in names canonical", () => {
		const registry = createRegistry(INTERACTIVE_COMMANDS);
		expect(registry.lookup("/quit")?.name).toBe("/exit");
		expect(registry.lookup("/help")?.name).toBe("/commands");
		expect(registry.lookup("/resume")?.name).toBe("/sessions");
		expect(parseSlashInput("/quit", { byName: new Map() })).toEqual({
			kind: "builtin",
			name: "/exit",
			args: "",
		});
	});

	it("refuses an extension that shadows a built-in name or alias", () => {
		const registry = createRegistry(INTERACTIVE_COMMANDS);
		expect(registry.register(stubCommand("/status", { source: { extension: "demo" } }))).toEqual({
			ok: false,
			reason: "builtin_override",
			detail: "/status",
		});
		expect(registry.register(stubCommand("/demo", { source: { extension: "demo" }, aliases: ["/help"] }))).toEqual({
			ok: false,
			reason: "builtin_override",
			detail: "/help",
		});
	});

	it("refuses a later extension that reuses another extension token", () => {
		const registry = new CommandRegistry();
		expect(registry.register(stubCommand("/demo", { source: { extension: "one" } })).ok).toBe(true);
		expect(registry.register(stubCommand("/demo", { source: { extension: "two" } }))).toEqual({
			ok: false,
			reason: "duplicate",
			detail: "/demo",
		});
	});

	it("runs a command and converts thrown errors into continue", async () => {
		const command = stubCommand("/boom", {
			run: async () => {
				throw new Error("exploded");
			},
		});
		const write = vi.fn();
		const result = await runCommand(command, { agent: {} as never, commands: [command], write }, "");
		expect(result).toEqual({ kind: "continue", error: true });
		expect(write).toHaveBeenCalledWith("error", "exploded");
	});

	it("finds availableDuringRun on skill commands only", () => {
		expect(findCommand(INTERACTIVE_COMMANDS, "/reload")?.availableDuringRun).toBe(true);
		expect(findCommand(INTERACTIVE_COMMANDS, "/reset")?.availableDuringRun).toBeUndefined();
	});
});
