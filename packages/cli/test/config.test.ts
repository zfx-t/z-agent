import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	ensureStarterConfig,
	NO_MODEL_WARNING,
	parseCatalog,
	resolveModel,
	STARTER_ALIAS,
	STARTER_MODEL_ID,
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
		await writeFile(path, `${first}\n# stay\n`, "utf-8");
		await ensureStarterConfig(dir);
		expect(await readFile(path, "utf-8")).toBe(`${first}\n# stay\n`);
	});
});
