import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(pkgRoot, "bin/z-agent.mjs");

describe("@z-agent/cli smoke", () => {
	it("runs faux demo offline and exercises tool path", () => {
		const result = spawnSync(process.execPath, [bin], {
			encoding: "utf8",
			env: { ...process.env, OPENAI_API_KEY: "" },
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		expect(result.stdout).toContain("[mode] faux (offline)");
		expect(result.stdout).toContain("[agent_start]");
		expect(result.stdout).toContain("[tool_start] echo");
		expect(result.stdout).toContain("[toolResult] echo: hi");
		expect(result.stdout).toContain("[assistant] Done — tool path exercised.");
		expect(result.stdout).toContain("[agent_end]");
	});
});
