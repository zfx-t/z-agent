import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(pkgRoot, "bin/z-agent.mjs");

/** Minimal env so NODE_OPTIONS / loaders cannot flaky-fail the spawn. */
function childEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH,
		HOME: process.env.HOME,
		SystemRoot: process.env.SystemRoot,
		TEMP: process.env.TEMP,
		TMP: process.env.TMP,
		TMPDIR: process.env.TMPDIR,
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
		const result = runCli([], { OPENAI_API_KEY: "" });
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("OPENAI_API_KEY is required");
	});

	it("exits 2 on unknown flags (not 0)", () => {
		const result = runCli(["--bogus"]);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("Unknown flag: --bogus");
		expect(result.stdout).toContain("z-agent — minimal agent smoke CLI");
	});

	it("exits 0 on --help", () => {
		const result = runCli(["--help"]);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Usage:");
		expect(result.stdout).toContain("OPENAI_API_KEY");
	});
});
