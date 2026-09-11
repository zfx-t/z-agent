import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	ensureStarterConfig,
	NO_MODEL_WARNING,
	parseCatalog,
	persistAliasSettings,
	resolveModel,
	STARTER_ALIAS,
	STARTER_CONTEXT_WINDOW,
	STARTER_MAX_TOKENS,
	STARTER_MODEL_ID,
	saveCatalog,
	updateAliasSettings,
} from "../src/config.ts";

describe("parseCatalog + resolveModel", () => {
	const catalog = parseCatalog(
		JSON.stringify({
			version: 1,
			defaultModel: "fast",
			models: {
				fast: { id: "gpt-4.1-mini" },
				smart: { id: "gpt-5", thinking: "high", contextWindow: 200_000 },
			},
		}),
	).catalog;

	it("resolves default alias and raw id", () => {
		const def = resolveModel(undefined, catalog, {});
		expect(def.hasModel).toBe(true);
		if (def.hasModel) {
			expect(def.alias).toBe("fast");
			expect(def.id).toBe("gpt-4.1-mini");
			expect(def.thinking).toBe("off");
		}
		const raw = resolveModel("gpt-4.1", catalog, {});
		expect(raw.hasModel).toBe(true);
		if (raw.hasModel) {
			expect(raw.id).toBe("gpt-4.1");
			expect(raw.alias).toBeUndefined();
		}
	});

	it("uses alias thinking and env over file key", () => {
		const smart = resolveModel("smart", catalog, {});
		expect(smart.hasModel && smart.thinking).toBe("high");
		expect(smart.hasModel && smart.contextWindow).toBe(200_000);
		const withEnv = resolveModel("fast", catalog, { OPENAI_API_KEY: "from-env", OPENAI_BASE_URL: "https://x" });
		expect(withEnv.hasModel && withEnv.apiKey).toBe("from-env");
		expect(withEnv.hasModel && withEnv.baseUrl).toBe("https://x");
	});

	it("resolves api field, anthropic env keys, and --api override", () => {
		const multi = parseCatalog(
			JSON.stringify({
				version: 1,
				defaultModel: "fast",
				models: {
					fast: { id: "gpt-4.1-mini" },
					claude: { id: "claude-sonnet-4-5", api: "anthropic-messages" },
					compat: { id: "deepseek-chat", api: "openai-completions", baseUrl: "https://api.deepseek.com" },
				},
			}),
		).catalog;

		const fast = resolveModel("fast", multi, {});
		expect(fast.hasModel && fast.api).toBe("openai-responses");

		const claude = resolveModel("claude", multi, {
			ANTHROPIC_API_KEY: "sk-ant",
			OPENAI_API_KEY: "sk-oai",
		});
		expect(claude.hasModel && claude.api).toBe("anthropic-messages");
		// ANTHROPIC_API_KEY wins for anthropic-messages entries; OPENAI_API_KEY does not leak.
		expect(claude.hasModel && claude.apiKey).toBe("sk-ant");
		const claudeFileKey = resolveModel("claude", multi, { OPENAI_API_KEY: "sk-oai" });
		expect(claudeFileKey.hasModel && claudeFileKey.apiKey).toBeUndefined();

		const compat = resolveModel("compat", multi, { OPENAI_API_KEY: "sk-oai" });
		expect(compat.hasModel && compat.api).toBe("openai-completions");
		expect(compat.hasModel && compat.apiKey).toBe("sk-oai");
		expect(compat.hasModel && compat.baseUrl).toBe("https://api.deepseek.com");

		// --api flag overrides the catalog entry.
		const forced = resolveModel("fast", multi, {}, { api: "openai-completions" });
		expect(forced.hasModel && forced.api).toBe("openai-completions");
	});

	it("rejects an unknown api value in config", () => {
		const loaded = parseCatalog(
			JSON.stringify({
				version: 1,
				defaultModel: "x",
				models: { x: { id: "m", api: "not-a-real-api" } },
			}),
		);
		expect(loaded.catalog).toBeUndefined();
		expect(loaded.warning).toMatch(/invalid config.json/);
	});

	it("warns with no model when default alias is missing", () => {
		const broken = parseCatalog(
			JSON.stringify({ version: 1, defaultModel: "missing", models: { fast: { id: "gpt-4.1-mini" } } }),
		).catalog;
		const resolved = resolveModel(undefined, broken, {});
		expect(resolved).toEqual({ hasModel: false, warning: NO_MODEL_WARNING });
	});

	it("rejects invalid json", () => {
		const loaded = parseCatalog("{");
		expect(loaded.catalog).toBeUndefined();
		expect(loaded.warning).toMatch(/invalid config.json/);
	});
});

describe("ensureStarterConfig", () => {
	it("writes a 0600 starter once", async () => {
		const dir = await mkdtemp(join(tmpdir(), "z-pillow-cfg-"));
		const path = await ensureStarterConfig(dir);
		const first = await readFile(path, "utf-8");
		expect(JSON.parse(first).defaultModel).toBe(STARTER_ALIAS);
		expect(JSON.parse(first).models[STARTER_ALIAS].id).toBe(STARTER_MODEL_ID);
		expect(JSON.parse(first).models[STARTER_ALIAS].contextWindow).toBe(STARTER_CONTEXT_WINDOW);
		expect(JSON.parse(first).models[STARTER_ALIAS].maxTokens).toBe(STARTER_MAX_TOKENS);
		await writeFile(path, `${first}\n# stay\n`, "utf-8");
		await ensureStarterConfig(dir);
		expect(await readFile(path, "utf-8")).toBe(`${first}\n# stay\n`);
	});
});

describe("alias settings persist", () => {
	it("patches one alias without dropping siblings or apiKey", () => {
		const catalog = {
			version: 1 as const,
			defaultModel: "fast",
			models: {
				fast: { id: "gpt-4.1-mini", apiKey: "sk-keep", contextWindow: 128_000 },
				smart: { id: "gpt-5", thinking: "high" as const },
			},
		};
		const next = updateAliasSettings(catalog, "fast", { contextWindow: 200_000, maxTokens: 8_192 });
		expect(next.models.fast).toEqual({
			id: "gpt-4.1-mini",
			apiKey: "sk-keep",
			contextWindow: 200_000,
			maxTokens: 8_192,
		});
		expect(next.models.smart).toEqual({ id: "gpt-5", thinking: "high" });
	});

	it("writes 0600 and reloads the latest file before patching", async () => {
		const dir = await mkdtemp(join(tmpdir(), "z-pillow-save-"));
		await saveCatalog(dir, {
			version: 1,
			defaultModel: "fast",
			models: { fast: { id: "gpt-4.1-mini", apiKey: "sk-file", contextWindow: 128_000 } },
		});
		await persistAliasSettings(dir, "fast", { contextWindow: 256_000, thinking: "low" });
		const raw = JSON.parse(await readFile(join(dir, "config.json"), "utf-8"));
		expect(raw.models.fast).toMatchObject({
			id: "gpt-4.1-mini",
			apiKey: "sk-file",
			contextWindow: 256_000,
			thinking: "low",
		});
	});

	it("prefers CLI overrides, then env, then catalog", () => {
		const catalog = parseCatalog(
			JSON.stringify({
				version: 1,
				defaultModel: "fast",
				models: { fast: { id: "gpt-4.1-mini", contextWindow: 128_000, maxTokens: 4_096 } },
			}),
		).catalog;
		const file = resolveModel("fast", catalog, {});
		expect(file.hasModel && file.contextWindow).toBe(128_000);
		const env = resolveModel("fast", catalog, {
			OPENAI_CONTEXT_WINDOW: "200000",
			OPENAI_MAX_TOKENS: "2048",
		});
		expect(env.hasModel && env.contextWindow).toBe(200_000);
		expect(env.hasModel && env.maxTokens).toBe(2_048);
		const flag = resolveModel(
			"fast",
			catalog,
			{ OPENAI_CONTEXT_WINDOW: "200000", OPENAI_MAX_TOKENS: "2048" },
			{ contextWindow: 300_000, maxTokens: 512 },
		);
		expect(flag.hasModel && flag.contextWindow).toBe(300_000);
		expect(flag.hasModel && flag.maxTokens).toBe(512);
		const raw = resolveModel("gpt-4.1", catalog, {});
		expect(raw.hasModel && raw.contextWindow).toBeUndefined();
		expect(raw.hasModel && raw.maxTokens).toBeUndefined();
	});
});
