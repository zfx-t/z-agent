/**
 * ~/.pillow/config.json — user model catalog (ADR-0022).
 */

import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThinkingLevel } from "@z-agent/ai";
import { z } from "zod";
import { looksLikeReasoningModel } from "./args.ts";
import { pillowUserDir } from "./pillow-home.ts";

export const CONFIG_VERSION = 1;
export const STARTER_ALIAS = "fast";
export const STARTER_MODEL_ID = "gpt-4.1-mini";
export const NO_MODEL_WARNING = "warning: no model in use";

const thinkingSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const modelEntrySchema = z.object({
	id: z.string().min(1),
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

export function configPath(userPillow = pillowUserDir()): string {
	return join(userPillow, "config.json");
}

export function starterCatalog(): PillowCatalog {
	return {
		version: CONFIG_VERSION,
		defaultModel: STARTER_ALIAS,
		models: {
			[STARTER_ALIAS]: { id: STARTER_MODEL_ID },
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

export function resolveModel(
	ref: string | undefined,
	catalog: PillowCatalog | undefined,
	env: NodeJS.ProcessEnv = process.env,
): ModelResolution {
	const usedDefault = ref === undefined;
	const name = ref ?? catalog?.defaultModel;
	if (!name) {
		return { hasModel: false, warning: NO_MODEL_WARNING };
	}

	const entry = catalog?.models[name];
	if (entry) {
		return {
			hasModel: true,
			id: entry.id,
			alias: name,
			baseUrl: env.OPENAI_BASE_URL || entry.baseUrl,
			apiKey: env.OPENAI_API_KEY || entry.apiKey,
			thinking: resolveThinking(entry.id, entry.thinking),
			contextWindow: entry.contextWindow,
			maxTokens: entry.maxTokens,
		};
	}

	if (usedDefault) {
		return { hasModel: false, warning: NO_MODEL_WARNING };
	}

	return {
		hasModel: true,
		id: name,
		baseUrl: env.OPENAI_BASE_URL || undefined,
		apiKey: env.OPENAI_API_KEY || undefined,
		thinking: resolveThinking(name),
	};
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
