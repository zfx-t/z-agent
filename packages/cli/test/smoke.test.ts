import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(pkgRoot, "bin/z-agent.mjs");

/** Minimal env so NODE_OPTIONS / loaders cannot flaky-fail the spawn. */
function childEnv(): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH,
		HOME: process.env.HOME,
		// Windows / some Node installs
		SystemRoot: process.env.SystemRoot,
		TEMP: process.env.TEMP,
		TMP: process.env.TMP,
		TMPDIR: process.env.TMPDIR,
		OPENAI_API_KEY: "",
	};
}

function runCli(args: string[] = []) {
	return spawnSync(process.execPath, [bin, ...args], {
		encoding: "utf8",
		env: childEnv(),
	});
}

describe("@z-agent/cli smoke", () => {
	it("runs faux demo offline and exercises tool path", () => {
		const result = runCli();
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr || result.stdout).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("[mode] faux (offline)");
		expect(result.stdout).toContain("[agent_start]");
		expect(result.stdout).toContain("[tool_start] echo");
		expect(result.stdout).toContain("[toolResult] echo: hi");
		expect(result.stdout).toContain("[assistant] Done — tool path exercised.");
		expect(result.stdout).toContain("[agent_end]");
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
	});
});
