import type { Agent, AgentEvent, AgentMessage } from "@z-agent/agent";
import type { SkillDiagnostic, SkillMode } from "@z-agent/skills";
import type { InteractiveCommand } from "./interactive-commands.ts";
import { INTERACTIVE_COMMANDS } from "./interactive-commands.ts";
import { extractSkillPathHints, type SkillManager, type SkillStatus } from "./skill-manager.ts";
import { type ParsedInput, parseSlashInput } from "./slash.ts";

export type SkillCommandLevel = "info" | "warning" | "error";

export type SkillInputResult =
	| { kind: "handled"; error?: boolean }
	| { kind: "request"; message: AgentMessage }
	| { kind: "builtin"; name: string; args: string };

export interface SkillInputCoordinatorOptions {
	agent: Agent;
	manager: SkillManager;
	commands?: readonly InteractiveCommand[];
	write?: (level: SkillCommandLevel, text: string) => void;
	onReload?: () => void;
}

const SKILL_BUILTINS = new Set(["/skill", "/skills", "/reload"]);

function userMessage(text: string): AgentMessage {
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

export class SkillInputCoordinator {
	private readonly agent: Agent;
	private readonly manager: SkillManager;
	private readonly commands: readonly InteractiveCommand[];
	private readonly write: (level: SkillCommandLevel, text: string) => void;
	private readonly onReload?: () => void;
	private readonly pending: string[] = [];
	private draining = false;

	constructor(options: SkillInputCoordinatorOptions) {
		this.agent = options.agent;
		this.manager = options.manager;
		this.commands = options.commands ?? INTERACTIVE_COMMANDS;
		this.write = options.write ?? (() => {});
		this.onReload = options.onReload;
	}

	subscribe(): () => void {
		return this.agent.subscribe(async (event: AgentEvent) => {
			if (event.type === "turn_end") {
				await this.drainAtBoundary();
			}
		});
	}

	enqueueDuringRun(line: string): void {
		this.pending.push(line);
		const token = line.trim().split(/\s/u, 1)[0] ?? line.trim();
		this.write("info", `[pending ${this.pending.length}] ${token}`);
	}

	hasPending(): boolean {
		return this.pending.length > 0;
	}

	takePendingAfterIdle(): string | undefined {
		return this.pending.shift();
	}

	async submit(line: string): Promise<SkillInputResult> {
		try {
			return await this.execute(this.parse(line));
		} catch (error) {
			this.write("error", errorMessage(error));
			return { kind: "handled", error: true };
		}
	}

	private parse(line: string): ParsedInput {
		return parseSlashInput(line, this.manager.getIndex(), this.commands);
	}

	private async drainAtBoundary(): Promise<void> {
		if (this.draining) {
			return;
		}
		this.draining = true;
		try {
			while (this.pending.length > 0) {
				const line = this.pending[0];
				if (line === undefined) {
					return;
				}
				const parsed = this.parse(line);
				if (parsed.kind === "builtin" && !SKILL_BUILTINS.has(parsed.name)) {
					return;
				}
				this.pending.shift();
				try {
					const result = await this.execute(parsed, false);
					if (result.kind === "request") {
						this.agent.steer(result.message);
						return;
					}
				} catch (error) {
					this.write("error", errorMessage(error));
				}
			}
		} finally {
			this.draining = false;
		}
	}

	private async execute(parsed: ParsedInput, prepareText = true): Promise<SkillInputResult> {
		if (parsed.kind === "error") {
			this.write("error", parsed.message);
			return { kind: "handled", error: true };
		}
		if (parsed.kind === "text") {
			if (prepareText) {
				await this.manager.prepareSnapshot({
					text: parsed.text,
					pathHints: extractSkillPathHints(parsed.text),
				});
			}
			const message = userMessage(parsed.text);
			return { kind: "request", message };
		}
		if (parsed.kind === "skill") {
			const snapshot = await this.manager.prepareSnapshot({ explicitName: parsed.name, args: parsed.args });
			this.write("info", `[skill] ${parsed.name} activated for this request`);
			return { kind: "request", message: this.manager.createInvocationMessage(snapshot) };
		}
		if (!SKILL_BUILTINS.has(parsed.name)) {
			return { kind: "builtin", name: parsed.name, args: parsed.args };
		}
		if (parsed.name === "/reload") {
			if (parsed.args.length > 0) {
				this.write("error", "Usage: /reload");
				return { kind: "handled", error: true };
			}
			const result = await this.manager.reload();
			this.onReload?.();
			this.write("info", `[reload] registry=${result.registryVersion} skills=${result.skillCount}`);
			for (const diagnostic of result.diagnostics) {
				if (diagnostic.severity !== "info") {
					this.write(diagnostic.severity, formatDiagnostic(diagnostic));
				}
			}
			return { kind: "handled" };
		}
		if (parsed.name === "/skills") {
			return await this.executeSkills(parsed.args);
		}
		return await this.executeSkill(parsed.args);
	}

	private async executeSkills(args: string): Promise<SkillInputResult> {
		if (args.startsWith("mode ")) {
			const mode = args.slice("mode ".length) as SkillMode;
			const result = await this.manager.setMode(mode);
			this.write(result.ok ? "info" : "error", result.message);
			return result.ok ? { kind: "handled" } : { kind: "handled", error: true };
		}
		const statuses = this.manager.list(args);
		const state = this.manager.getState();
		this.write(
			"info",
			`[skills] mode=${state.mode} active=${state.active.length} stale=${state.stale.length} registry=${this.manager.getIndex().version}`,
		);
		if (statuses.length === 0) {
			this.write("info", args ? `No skills match: ${args}` : "No skills discovered");
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
			this.write(
				status.stale ? "warning" : "info",
				`${status.name} [${stateLabel(status)}] ${status.source} ${status.location}${origin}${match} - ${status.description}`,
			);
		}
		for (const diagnostic of this.manager.getDiagnostics()) {
			if (diagnostic.severity !== "info") {
				this.write(diagnostic.severity, formatDiagnostic(diagnostic));
			}
		}
		return { kind: "handled" };
	}

	private async executeSkill(args: string): Promise<SkillInputResult> {
		const { first, rest } = splitFirst(args);
		if (first === "all") {
			if (rest) {
				this.write("error", "Usage: /skill all");
				return { kind: "handled", error: true };
			}
			const results = await this.manager.activateAll();
			const activated = results.filter((result) => result.ok && result.changed).length;
			for (const result of results) {
				if (!result.ok) {
					this.write("error", result.message);
				}
			}
			this.write("info", `[skill] activated ${activated}; active=${this.manager.getState().active.length}`);
			return results.some((result) => !result.ok) ? { kind: "handled", error: true } : { kind: "handled" };
		}
		if (first.startsWith("-")) {
			if (rest || first.length === 1) {
				this.write("error", "Usage: /skill -<name>");
				return { kind: "handled", error: true };
			}
			const result = await this.manager.deactivate(first.slice(1), "command");
			this.write(result.ok ? "info" : "error", result.message);
			return result.ok ? { kind: "handled" } : { kind: "handled", error: true };
		}
		const snapshot = await this.manager.prepareSnapshot({ explicitName: first, args: rest });
		this.write("info", `[skill] ${first} activated for this request`);
		return { kind: "request", message: this.manager.createInvocationMessage(snapshot) };
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
