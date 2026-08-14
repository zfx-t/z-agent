import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { askYesNo, ensureProjectTrust, isTrusted, markTrusted, trustStorePath } from "../src/trust.ts";

describe("project trust", () => {
	it("records a trusted cwd after ask returns true", async () => {
		const root = await mkdtemp(join(tmpdir(), "z-trust-store-"));
		const store = trustStorePath(root);
		const cwd = await mkdtemp(join(tmpdir(), "z-trust-cwd-"));
		expect(await isTrusted(cwd, store)).toBe(false);
		const ok = await ensureProjectTrust(cwd, async () => true, store);
		expect(ok).toBe(true);
		expect(await isTrusted(cwd, store)).toBe(true);
		await markTrusted(cwd, store);
		expect(store).toContain("trust.json");
	});

	it("askYesNo is false on non-TTY", async () => {
		const dir = await mkdtemp(join(tmpdir(), "z-ask-"));
		const file = join(dir, "in.txt");
		await writeFile(file, "yes\n", "utf-8");
		const { createReadStream } = await import("node:fs");
		const input = createReadStream(file);
		await new Promise<void>((resolve) => {
			input.once("open", () => resolve());
		});
		expect(await askYesNo("Trust?", input)).toBe(false);
		input.close();
	});
});
