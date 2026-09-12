import { describe, expect, it } from "vitest";
import {
	buildChildEnv,
	DEFAULT_BASH_ENV_POLICY,
	DEFAULT_SECRET_PATTERNS,
	PROTECTED_KEYS,
} from "../src/tools/bash-env.ts";

const SOURCE: NodeJS.ProcessEnv = {
	PATH: "/usr/bin",
	HOME: "/home/u",
	OPENAI_API_KEY: "sk-test",
	MY_SERVICE_TOKEN: "tok",
	GITHUB_TOKEN: "ghp_x",
	DATABASE_URL: "postgres://x",
	NODE_ENV: "test",
	AWS_ACCESS_KEY_ID: "AKIA",
	AWS_SECRET_ACCESS_KEY: "aws-secret",
};

describe("buildChildEnv", () => {
	it("scrubs secret-shaped names under the default policy", () => {
		const env = buildChildEnv(SOURCE, DEFAULT_BASH_ENV_POLICY, "linux");
		expect(env.PATH).toBe("/usr/bin");
		expect(env.HOME).toBe("/home/u");
		expect(env.NODE_ENV).toBe("test");
		expect(env.AWS_ACCESS_KEY_ID).toBe("AKIA");
		expect(env.OPENAI_API_KEY).toBeUndefined();
		expect(env.MY_SERVICE_TOKEN).toBeUndefined();
		expect(env.GITHUB_TOKEN).toBeUndefined();
		expect(env.DATABASE_URL).toBeUndefined();
		expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
	});

	it("defaults to the scrub policy when none is given", () => {
		const env = buildChildEnv(SOURCE);
		expect(env.OPENAI_API_KEY).toBeUndefined();
		expect(env.PATH).toBe("/usr/bin");
	});

	it("inherit returns an equal copy, not the same object", () => {
		const env = buildChildEnv(SOURCE, { mode: "inherit" }, "linux");
		expect(env).toEqual(SOURCE);
		expect(env).not.toBe(SOURCE);
	});

	it("allow names win over deny patterns", () => {
		const env = buildChildEnv(SOURCE, { mode: "scrub", allow: ["GITHUB_TOKEN"] }, "linux");
		expect(env.GITHUB_TOKEN).toBe("ghp_x");
		expect(env.OPENAI_API_KEY).toBeUndefined();
	});

	it("extra deny patterns drop additional names on top of the defaults", () => {
		const env = buildChildEnv(SOURCE, { mode: "scrub", deny: [/^NODE_ENV$/u] }, "linux");
		expect(env.NODE_ENV).toBeUndefined();
		expect(env.OPENAI_API_KEY).toBeUndefined();
		expect(env.PATH).toBe("/usr/bin");
	});

	it("set is applied last, even in inherit mode", () => {
		const env = buildChildEnv(
			SOURCE,
			{ mode: "scrub", set: { OPENAI_API_KEY: "forced", PILLOW_MARK: "1" } },
			"linux",
		);
		expect(env.OPENAI_API_KEY).toBe("forced");
		expect(env.PILLOW_MARK).toBe("1");
		const inherited = buildChildEnv(SOURCE, { mode: "inherit", set: { PILLOW_MARK: "2" } }, "linux");
		expect(inherited.PILLOW_MARK).toBe("2");
		expect(inherited.OPENAI_API_KEY).toBe("sk-test");
	});

	it("never scrubs protected keys even when they match a deny pattern", () => {
		const source: NodeJS.ProcessEnv = { PATH: "/bin", LC_ALL: "C", TMPDIR: "/tmp" };
		const env = buildChildEnv(source, { mode: "scrub", deny: [/.*/u] }, "linux");
		expect(env.PATH).toBe("/bin");
		expect(env.LC_ALL).toBe("C");
		expect(env.TMPDIR).toBe("/tmp");
	});

	it("compares case-insensitively on win32", () => {
		const source: NodeJS.ProcessEnv = { Path: "C:\\bin", openai_api_key: "sk-lower", ComSpec: "C:\\cmd.exe" };
		const env = buildChildEnv(source, DEFAULT_BASH_ENV_POLICY, "win32");
		expect(env.Path).toBe("C:\\bin");
		expect(env.ComSpec).toBe("C:\\cmd.exe");
		expect(env.openai_api_key).toBeUndefined();
	});

	it("never emits undefined values", () => {
		const source: NodeJS.ProcessEnv = { PATH: "/bin", MISSING: undefined };
		for (const policy of [DEFAULT_BASH_ENV_POLICY, { mode: "inherit" as const }]) {
			const env = buildChildEnv(source, policy, "linux");
			expect(Object.values(env).every((value) => value !== undefined)).toBe(true);
		}
	});

	it("exposes the documented patterns and protected keys", () => {
		expect(DEFAULT_SECRET_PATTERNS.length).toBeGreaterThan(0);
		for (const key of ["PATH", "HOME", "COMSPEC", "SYSTEMROOT", "PATHEXT", "PWD"]) {
			expect(PROTECTED_KEYS.has(key)).toBe(true);
		}
	});
});
