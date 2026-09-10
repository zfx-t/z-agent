import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadKeymap } from "../src/keys-config.ts";

describe("keys.json", () => {
	it("loads overrides and ignores a missing file", async () => {
		const missing = await loadKeymap(await mkdtemp(join(tmpdir(), "z-keys-missing-")));
		expect(missing.warnings).toEqual([]);
		const dir = await mkdtemp(join(tmpdir(), "z-keys-"));
		await writeFile(join(dir, "keys.json"), JSON.stringify({ palette: "ctrl+k", interrupt: "ctrl+x" }), "utf-8");
		const loaded = await loadKeymap(dir);
		expect(loaded.warnings.some((warning) => warning.includes("interrupt"))).toBe(true);
	});

	it("warns on malformed JSON and keeps defaults", async () => {
		const dir = await mkdtemp(join(tmpdir(), "z-keys-bad-"));
		await writeFile(join(dir, "keys.json"), "{", "utf-8");
		const loaded = await loadKeymap(dir);
		expect(loaded.warnings[0]).toContain("keys.json:");
	});
});
