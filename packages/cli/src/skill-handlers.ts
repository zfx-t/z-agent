import type { AgentMessage } from "@z-agent/agent";
import type { SkillDiagnostic, SkillMode } from "@z-agent/skills";
import type { CommandContext, CommandLevel, CommandRunResult } from "./command-types.ts";
import type { SkillStatus } from "./skill-manager.ts";

export function writeCommand(context: CommandContext, level: CommandLevel, text: string): void {
	if (context.write) {
		context.write(level, text);
		return;
	}
	if (level === "info") {
		context.tui?.appendLine(text);
		return;
	}
	context.tui?.appendNotice(level, text);
}

export async function runReloadCommand(context: CommandContext, args: string): Promise<CommandRunResult> {
	if (args.length > 0) {
		writeCommand(context, "error", "Usage: /reload");
		return { kind: "continue", error: true };
	}
	if (!context.skills) {
		writeCommand(context, "error", "skills are unavailable");
		return { kind: "continue", error: true };
	}
	const result = await context.skills.reload();
	context.onReload?.();
	writeCommand(context, "info", `[reload] registry=${result.registryVersion} skills=${result.skillCount}`);
	for (const diagnostic of result.diagnostics) {
		if (diagnostic.severity !== "info") {
			writeCommand(context, diagnostic.severity, formatDiagnostic(diagnostic));
		}
	}
	return { kind: "continue" };
}

export async function runSkillsCommand(context: CommandContext, args: string): Promise<CommandRunResult> {
	if (!context.skills) {
		writeCommand(context, "error", "skills are unavailable");
		return { kind: "continue", error: true };
	}
	if (args.startsWith("mode ")) {
		const mode = args.slice("mode ".length) as SkillMode;
		const result = await context.skills.setMode(mode);
		writeCommand(context, result.ok ? "info" : "error", result.message);
		return result.ok ? { kind: "continue" } : { kind: "continue", error: true };
	}
	const statuses = context.skills.list(args);
	const state = context.skills.getState();
	writeCommand(
		context,
		"info",
		`[skills] mode=${state.mode} active=${state.active.length} stale=${state.stale.length} registry=${context.skills.getIndex().version}`,
	);
	if (statuses.length === 0) {
		writeCommand(context, "info", args ? `No skills match: ${args}` : "No skills discovered");
	}
	for (const status of statuses) {
		const origin = status.origin ? ` origin=${status.origin}` : "";
		const match =
			status.score !== undefined
				? ` score=${status.score}${status.matchExclusion ? ` exclusion=${status.matchExclusion}` : ""}${
						status.matchReasons && status.matchReasons.length > 0
							? ` reason=${status.matchReasons.join(";")}`
							: ""
					}`
				: "";
		writeCommand(
			context,
			status.stale ? "warning" : "info",
			`${status.name} [${stateLabel(status)}] ${status.source} ${status.location}${origin}${match} - ${status.description}`,
		);
	}
	for (const diagnostic of context.skills.getDiagnostics()) {
		if (diagnostic.severity !== "info") {
			writeCommand(context, diagnostic.severity, formatDiagnostic(diagnostic));
		}
	}
	return { kind: "continue" };
}

export async function runSkillCommand(context: CommandContext, args: string): Promise<CommandRunResult> {
	if (!context.skills) {
		writeCommand(context, "error", "skills are unavailable");
		return { kind: "continue", error: true };
	}
	const { first, rest } = splitFirst(args);
	if (first === "all") {
		if (rest) {
			writeCommand(context, "error", "Usage: /skill all");
			return { kind: "continue", error: true };
		}
		const results = await context.skills.activateAll();
		const activated = results.filter((result) => result.ok && result.changed).length;
		for (const result of results) {
			if (!result.ok) {
				writeCommand(context, "error", result.message);
			}
		}
		writeCommand(
			context,
			"info",
			`[skill] activated ${activated}; active=${context.skills.getState().active.length}`,
		);
		return results.some((result) => !result.ok) ? { kind: "continue", error: true } : { kind: "continue" };
	}
	if (first.startsWith("-")) {
		if (rest || first.length === 1) {
			writeCommand(context, "error", "Usage: /skill -<name>");
			return { kind: "continue", error: true };
		}
		const result = await context.skills.deactivate(first.slice(1), "command");
		writeCommand(context, result.ok ? "info" : "error", result.message);
		return result.ok ? { kind: "continue" } : { kind: "continue", error: true };
	}
	const snapshot = await context.skills.prepareSnapshot({ explicitName: first, args: rest });
	writeCommand(context, "info", `[skill] ${first} activated for this request`);
	return { kind: "request", message: context.skills.createInvocationMessage(snapshot) };
}

export function userTextMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function splitFirst(value: string): { first: string; rest: string } {
	const trimmed = value.trim();
	const separator = trimmed.search(/\s/u);
	return separator < 0
		? { first: trimmed, rest: "" }
		: { first: trimmed.slice(0, separator), rest: trimmed.slice(separator).trimStart() };
}

function stateLabel(status: SkillStatus): string {
	const labels = [
		status.active ? "active" : "inactive",
		...(status.hidden ? ["hidden"] : []),
		...(status.stale ? ["stale"] : []),
		...(status.manualOff ? ["manual-off"] : []),
		...(status.collision ? ["collision"] : []),
	];
	return labels.join(",");
}

function formatDiagnostic(diagnostic: SkillDiagnostic): string {
	const subject = diagnostic.skillName ? ` ${diagnostic.skillName}` : "";
	return `[${diagnostic.severity}]${subject} ${diagnostic.code}: ${diagnostic.message}`;
}
