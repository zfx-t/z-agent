import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensurePillowDir } from "../src/pillow-home.ts";

describe("ensurePillowDir", () => {
	it("copies legacy when target is missing", async () => {
		const root = await mkdtemp(join(tmpdir(), "z-pillow-mig-"));
		const legacy = join(root, ".z-agent");
		const target = join(root, ".pillow");
		await mkdir(legacy, { recursive: true });
		await writeFile(join(legacy, "keep.txt"), "ok", "utf-8");
		await ensurePillowDir(target, legacy);
		const { readFile } = await import("node:fs/promises");
		expect(await readFile(join(target, "keep.txt"), "utf-8")).toBe("ok");
		expect(await readFile(join(legacy, "keep.txt"), "utf-8")).toBe("ok");
	});

	it("does not overwrite an existing target", async () => {
		const root = await mkdtemp(join(tmpdir(), "z-pillow-keep-"));
		const legacy = join(root, ".z-agent");
		const target = join(root, ".pillow");
		await mkdir(legacy, { recursive: true });
		await mkdir(target, { recursive: true });
		await writeFile(join(legacy, "a.txt"), "legacy", "utf-8");
		await writeFile(join(target, "a.txt"), "pillow", "utf-8");
		await ensurePillowDir(target, legacy);
		const { readFile } = await import("node:fs/promises");
		expect(await readFile(join(target, "a.txt"), "utf-8")).toBe("pillow");
	});
});
