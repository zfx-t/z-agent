import type { ThinkingLevel } from "@z-agent/ai";

export const MODEL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const MODEL_COMMAND_USAGE =
	"Usage: /model, /model context <n>, /model max-tokens <n>, or /model thinking off|minimal|low|medium|high|xhigh|max";

export type ModelPersistMode = "alias" | "session";

export interface ModelSettingsView {
	hasModel: boolean;
	alias?: string;
	id: string;
	api?: string;
	thinking: ThinkingLevel;
	contextWindow?: number;
	maxTokens?: number;
	persist: ModelPersistMode;
}

export type ParsedModelCommand =
	| { kind: "inspect" }
	| { kind: "set"; field: "context"; value: number }
	| { kind: "set"; field: "max-tokens"; value: number }
	| { kind: "set"; field: "thinking"; value: ThinkingLevel }
	| { kind: "error"; message: string };

export interface AliasSettingsPatch {
	contextWindow?: number;
	maxTokens?: number;
	thinking?: ThinkingLevel;
}

export type ModelSettingsResult =
	| { kind: "inspect"; text: string }
	| { kind: "updated"; view: ModelSettingsView; text: string; persistPatch?: AliasSettingsPatch }
	| { kind: "error"; message: string };

export function isThinkingLevel(value: string): value is ThinkingLevel {
	return (MODEL_THINKING_LEVELS as readonly string[]).includes(value);
}

export function finitePositiveInt(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function optionalPositive(value: number | undefined): number | undefined {
	return finitePositiveInt(value) ? value : undefined;
}

export function modelSettingsView(input: {
	hasModel: boolean;
	alias?: string;
	id?: string;
	api?: string;
	thinking?: ThinkingLevel;
	contextWindow?: number;
	maxTokens?: number;
}): ModelSettingsView {
	if (!input.hasModel) {
		return { hasModel: false, id: "none", thinking: "off", persist: "session" };
	}
	const alias = input.alias?.trim();
	return {
		hasModel: true,
		...(alias ? { alias } : {}),
		id: input.id?.trim() || "unknown",
		...(input.api ? { api: input.api } : {}),
		thinking: input.thinking ?? "off",
		...(optionalPositive(input.contextWindow) !== undefined
			? { contextWindow: optionalPositive(input.contextWindow) }
			: {}),
		...(optionalPositive(input.maxTokens) !== undefined ? { maxTokens: optionalPositive(input.maxTokens) } : {}),
		persist: alias ? "alias" : "session",
	};
}

function splitArgs(args: string): { first: string; rest: string } {
	const trimmed = args.trim();
	const separator = trimmed.search(/\s/u);
	return separator < 0
		? { first: trimmed, rest: "" }
		: { first: trimmed.slice(0, separator), rest: trimmed.slice(separator).trimStart() };
}

function parsePositiveIntToken(token: string): number | undefined {
	if (!/^\d+$/u.test(token)) {
		return undefined;
	}
	const value = Number(token);
	return finitePositiveInt(value) ? value : undefined;
}

export function parseModelCommand(args: string): ParsedModelCommand {
	const trimmed = args.trim();
	if (trimmed.length === 0) {
		return { kind: "inspect" };
	}
	const { first, rest } = splitArgs(trimmed);
	if (first === "context" || first === "max-tokens") {
		const value = parsePositiveIntToken(rest);
		if (value === undefined || rest.includes(" ")) {
			return { kind: "error", message: MODEL_COMMAND_USAGE };
		}
		return { kind: "set", field: first, value };
	}
	if (first === "thinking" && isThinkingLevel(rest)) {
		return { kind: "set", field: "thinking", value: rest };
	}
	return { kind: "error", message: MODEL_COMMAND_USAGE };
}

function renderCount(value: number | undefined): string {
	return optionalPositive(value) === undefined ? "unknown" : String(value);
}

export function formatModelSettings(view: ModelSettingsView): string {
	if (!view.hasModel) {
		return "[model] none";
	}
	const alias = view.alias ? `alias=${view.alias} ` : "";
	const api = view.api ? ` api=${view.api}` : "";
	return `[model] ${alias}id=${view.id}${api} thinking=${view.thinking} contextWindow=${renderCount(view.contextWindow)} maxTokens=${renderCount(view.maxTokens)} persist=${view.persist}`;
}

export function formatRuntimeStatus(input: {
	view: ModelSettingsView;
	skillsMode: string;
	skillsActive: number;
	cwd: string;
}): string {
	const label = !input.view.hasModel
		? "none"
		: input.view.alias
			? `${input.view.alias}(${input.view.id})`
			: input.view.id;
	const api = input.view.api ? ` api=${input.view.api}` : "";
	return `[status] model=${label}${api} thinking=${input.view.thinking} contextWindow=${renderCount(input.view.contextWindow)} maxTokens=${renderCount(input.view.maxTokens)} persist=${input.view.persist} skills=${input.skillsMode}:${input.skillsActive} cwd=${input.cwd}`;
}

export function formatCompactContext(window?: number): string {
	const value = optionalPositive(window);
	if (value === undefined) {
		return "unknown";
	}
	if (value >= 1_000_000 && value % 1_000_000 === 0) {
		return `${value / 1_000_000}m`;
	}
	if (value >= 1_000 && value % 1_000 === 0) {
		return `${value / 1_000}k`;
	}
	return String(value);
}

export function formatListModelsLine(input: {
	alias: string;
	id: string;
	contextWindow?: number;
	maxTokens?: number;
	thinking?: ThinkingLevel;
	isDefault?: boolean;
}): string {
	const window = optionalPositive(input.contextWindow);
	const tokens = optionalPositive(input.maxTokens);
	const marker = input.isDefault ? " *" : "";
	return `${input.alias}\t${input.id}\t${window ?? "-"}\t${tokens ?? "-"}\t${input.thinking ?? "-"}${marker}`;
}

/** Single-row model picker item: aligned alias, wire/api facts, markers. */
export function formatModelPickerRow(input: {
	alias: string;
	id: string;
	api?: string;
	contextWindow?: number;
	maxTokens?: number;
	thinking?: ThinkingLevel;
	isCurrent?: boolean;
	isDefault?: boolean;
	aliasWidth?: number;
}): string {
	const alias = input.alias.padEnd(input.aliasWidth ?? input.alias.length);
	const api = input.api ? ` ${input.api}` : "";
	const window = optionalPositive(input.contextWindow);
	const tokens = optionalPositive(input.maxTokens);
	const marks = `${input.isDefault ? " *" : ""}${input.isCurrent ? " (current)" : ""}`;
	return `${alias}  ${input.id}${api}  ctx ${window === undefined ? "-" : formatCompactContext(window)}  max ${tokens ?? "-"}  think ${input.thinking ?? "-"}${marks}`;
}

export function reduceModelSettings(view: ModelSettingsView, args: string): ModelSettingsResult {
	const parsed = parseModelCommand(args);
	if (parsed.kind === "error") {
		return parsed;
	}
	if (parsed.kind === "inspect") {
		return { kind: "inspect", text: formatModelSettings(view) };
	}
	if (!view.hasModel) {
		return { kind: "error", message: "no model in use" };
	}
	const next = { ...view };
	const persistPatch: AliasSettingsPatch = {};
	if (parsed.field === "context") {
		next.contextWindow = parsed.value;
		persistPatch.contextWindow = parsed.value;
	} else if (parsed.field === "max-tokens") {
		next.maxTokens = parsed.value;
		persistPatch.maxTokens = parsed.value;
	} else {
		next.thinking = parsed.value;
		persistPatch.thinking = parsed.value;
	}
	return {
		kind: "updated",
		view: next,
		text: formatModelSettings(next),
		...(next.persist === "alias" ? { persistPatch } : {}),
	};
}
