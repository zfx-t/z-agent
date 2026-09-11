/**
 * ~/.pillow/config.json — user model catalog (ADR-0022).
 */

import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderApi, ThinkingLevel } from "@z-agent/ai";
import { z } from "zod";
import { looksLikeReasoningModel } from "./args.ts";
import type { AliasSettingsPatch } from "./model-settings.ts";
import { pillowUserDir } from "./pillow-home.ts";

export const CONFIG_VERSION = 1;
export const STARTER_ALIAS = "fast";
export const STARTER_MODEL_ID = "gpt-4.1-mini";
export const STARTER_CONTEXT_WINDOW = 128_000;
export const STARTER_MAX_TOKENS = 4_096;
export const NO_MODEL_WARNING = "warning: no model in use";

const thinkingSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const apiSchema = z.enum(["openai-responses", "openai-completions", "anthropic-messages"] satisfies [
	ProviderApi,
	...ProviderApi[],
]);

const modelEntrySchema = z.object({
	id: z.string().min(1),
	api: apiSchema.optional(),
	baseUrl: z.string().min(1).optional(),
	apiKey: z.string().min(1).optional(),
	thinking: thinkingSchema.optional(),
	contextWindow: z.number().int().positive().optional(),
	maxTokens: z.number().int().positive().optional(),
});

const catalogSchema = z.object({
	version: z.literal(CONFIG_VERSION),
	defaultModel: z.string().min(1),
	models: z.record(modelEntrySchema),
});

export type ModelEntry = z.infer<typeof modelEntrySchema>;
export type PillowCatalog = z.infer<typeof catalogSchema>;

export interface LoadCatalogResult {
	catalog?: PillowCatalog;
	warning?: string;
}

export interface ResolvedModel {
	hasModel: true;
	id: string;
	alias?: string;
	api: ProviderApi;
	baseUrl?: string;
	apiKey?: string;
	thinking: ThinkingLevel;
	contextWindow?: number;
	maxTokens?: number;
}

export interface UnresolvedModel {
	hasModel: false;
	warning: string;
}

export type ModelResolution = ResolvedModel | UnresolvedModel;

export interface ModelNumericOverrides {
	contextWindow?: number;
	maxTokens?: number;
	/** Overrides the catalog entry's api selection (--api flag). */
	api?: ProviderApi;
}

export function configPath(userPillow = pillowUserDir()): string {
	return join(userPillow, "config.json");
}

export function starterCatalog(): PillowCatalog {
	return {
		version: CONFIG_VERSION,
		defaultModel: STARTER_ALIAS,
		models: {
			[STARTER_ALIAS]: {
				id: STARTER_MODEL_ID,
				contextWindow: STARTER_CONTEXT_WINDOW,
				maxTokens: STARTER_MAX_TOKENS,
			},
		},
	};
}

export async function ensureStarterConfig(userPillow: string): Promise<string> {
	const path = configPath(userPillow);
	try {
		await readFile(path, "utf-8");
		return path;
	} catch {
		const body = `${JSON.stringify(starterCatalog(), null, 2)}\n`;
		await writeFile(path, body, { encoding: "utf-8", mode: 0o600 });
		await chmod(path, 0o600);
		return path;
	}
}

export function parseCatalog(raw: string): LoadCatalogResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { warning: `invalid config.json: ${detail}` };
	}
	const result = catalogSchema.safeParse(parsed);
	if (!result.success) {
		return { warning: `invalid config.json: ${result.error.issues[0]?.message ?? "schema"}` };
	}
	return { catalog: result.data };
}

export async function loadCatalog(userPillow: string): Promise<LoadCatalogResult> {
	const path = configPath(userPillow);
	try {
		return parseCatalog(await readFile(path, "utf-8"));
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { warning: `could not read config.json: ${detail}` };
	}
}

export function resolveThinking(id: string, thinking?: ThinkingLevel): ThinkingLevel {
	if (thinking !== undefined) {
		return thinking;
	}
	return looksLikeReasoningModel(id) ? "medium" : "off";
}

function positiveIntEnv(env: NodeJS.ProcessEnv, key: string): number | undefined {
	const raw = env[key]?.trim();
	if (!raw) {
		return undefined;
	}
	if (!/^\d+$/u.test(raw)) {
		return undefined;
	}
	const value = Number(raw);
	return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function resolveNumericField(
	override: number | undefined,
	envValue: number | undefined,
	fileValue: number | undefined,
): number | undefined {
	return override ?? envValue ?? fileValue;
}

/** Per-api env vars for key/baseUrl resolution (ADR-0027). */
function envNamesForApi(api: ProviderApi): { key: string; baseUrl: string } {
	return api === "anthropic-messages"
		? { key: "ANTHROPIC_API_KEY", baseUrl: "ANTHROPIC_BASE_URL" }
		: { key: "OPENAI_API_KEY", baseUrl: "OPENAI_BASE_URL" };
}

export function resolveModel(
	ref: string | undefined,
	catalog: PillowCatalog | undefined,
	env: NodeJS.ProcessEnv = process.env,
	overrides: ModelNumericOverrides = {},
): ModelResolution {
	const usedDefault = ref === undefined;
	const name = ref ?? catalog?.defaultModel;
	if (!name) {
		return { hasModel: false, warning: NO_MODEL_WARNING };
	}

	const entry = catalog?.models[name];
	const api: ProviderApi = overrides.api ?? entry?.api ?? "openai-responses";
	const envNames = envNamesForApi(api);
	if (entry) {
		return {
			hasModel: true,
			id: entry.id,
			alias: name,
			api,
			baseUrl: env[envNames.baseUrl] || entry.baseUrl,
			apiKey: env[envNames.key] || entry.apiKey,
			thinking: resolveThinking(entry.id, entry.thinking),
			contextWindow: resolveNumericField(
				overrides.contextWindow,
				positiveIntEnv(env, "OPENAI_CONTEXT_WINDOW"),
				entry.contextWindow,
			),
			maxTokens: resolveNumericField(overrides.maxTokens, positiveIntEnv(env, "OPENAI_MAX_TOKENS"), entry.maxTokens),
		};
	}

	if (usedDefault) {
		return { hasModel: false, warning: NO_MODEL_WARNING };
	}

	return {
		hasModel: true,
		id: name,
		api,
		baseUrl: env[envNames.baseUrl] || undefined,
		apiKey: env[envNames.key] || undefined,
		thinking: resolveThinking(name),
		contextWindow: resolveNumericField(
			overrides.contextWindow,
			positiveIntEnv(env, "OPENAI_CONTEXT_WINDOW"),
			undefined,
		),
		maxTokens: resolveNumericField(overrides.maxTokens, positiveIntEnv(env, "OPENAI_MAX_TOKENS"), undefined),
	};
}

export function updateAliasSettings(catalog: PillowCatalog, alias: string, patch: AliasSettingsPatch): PillowCatalog {
	const current = catalog.models[alias];
	if (!current) {
		throw new Error(`alias ${alias} is not in config.json`);
	}
	return {
		...catalog,
		models: {
			...catalog.models,
			[alias]: {
				...current,
				...patch,
			},
		},
	};
}

export async function saveCatalog(userPillow: string, catalog: PillowCatalog): Promise<void> {
	const path = configPath(userPillow);
	const body = `${JSON.stringify(catalog, null, 2)}\n`;
	await writeFile(path, body, { encoding: "utf-8", mode: 0o600 });
	await chmod(path, 0o600);
}

export async function persistAliasSettings(
	userPillow: string,
	alias: string,
	patch: AliasSettingsPatch,
): Promise<void> {
	const loaded = await loadCatalog(userPillow);
	if (!loaded.catalog) {
		throw new Error(loaded.warning ?? "could not read config.json");
	}
	await saveCatalog(userPillow, updateAliasSettings(loaded.catalog, alias, patch));
}

export function modelRefFromArgs(
	modelFlag: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const flag = modelFlag?.trim();
	if (flag) {
		return flag;
	}
	const fromEnv = env.OPENAI_MODEL?.trim();
	return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}
