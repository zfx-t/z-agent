import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(pkgRoot, "bin/z-agent.mjs");

const smokePillow = join(tmpdir(), "z-agent-smoke-pillow");

function childEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH,
		HOME: process.env.HOME,
		SystemRoot: process.env.SystemRoot,
		TEMP: process.env.TEMP,
		TMP: process.env.TMP,
		TMPDIR: process.env.TMPDIR,
		PILLOW_HOME: smokePillow,
		...extra,
	};
}

function runCli(args: string[] = [], env: NodeJS.ProcessEnv = {}) {
	return spawnSync(process.execPath, [bin, ...args], {
		encoding: "utf8",
		env: childEnv(env),
	});
}

describe("@z-agent/cli smoke", () => {
	it("exits 1 without OPENAI_API_KEY", () => {
		const result = runCli(["-p", "hi"], { OPENAI_API_KEY: "" });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("OPENAI_API_KEY is required");
	});

	it("exits 2 on unknown flags", () => {
		const result = runCli(["--bogus"]);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("Unknown flag: --bogus");
	});

	it("exits 0 on --help", () => {
		const result = runCli(["--help"]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Usage:");
		expect(result.stdout).toContain("TUI");
	});

	it("lists configured models without requiring an API key", () => {
		const dir = mkdtempSync(join(tmpdir(), "z-smoke-list-models-"));
		const result = runCli(["--list-models"], { OPENAI_API_KEY: "", PILLOW_HOME: dir });
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("fast");
		expect(result.stdout).toContain("gpt-4.1-mini");
		expect(result.stdout).toContain("128000");
		expect(result.stdout).toContain("4096");
	});

	it("print warns when config is broken and no model is set", () => {
		const dir = mkdtempSync(join(tmpdir(), "z-smoke-bad-cfg-"));
		writeFileSync(join(dir, "config.json"), "{", "utf-8");
		const result = runCli(["-p", "hi"], { OPENAI_API_KEY: "sk-test", PILLOW_HOME: dir });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("no model in use");
	});
});
