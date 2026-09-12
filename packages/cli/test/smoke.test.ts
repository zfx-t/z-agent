import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

/** Local SSE stub: one response.completed then [DONE] (same shape as the Loop A acceptance stub). */
const STUB_SOURCE = `
import http from "node:http";
http.createServer((req, res) => {
	req.resume();
	res.writeHead(200, { "content-type": "text/event-stream" });
	res.end(
		"data: " + JSON.stringify({ type: "response.completed",
			response: { id: "r_smoke", status: "completed",
				usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } }) + "\\n\\n" +
		"data: [DONE]\\n\\n",
	);
}).listen(0, "127.0.0.1", function () { console.log("PORT=" + this.address().port); });
`;

function startStub(): Promise<{ port: number; stop: () => void }> {
	const child = spawn(process.execPath, ["-e", STUB_SOURCE], { stdio: ["ignore", "pipe", "inherit"] });
	return new Promise((resolve, reject) => {
		let buf = "";
		child.stdout.on("data", (chunk) => {
			buf += chunk;
			const match = /PORT=(\d+)/.exec(buf);
			if (match) {
				resolve({ port: Number(match[1]), stop: () => child.kill() });
			}
		});
		child.on("error", reject);
		child.on("exit", () => reject(new Error("stub exited before PORT")));
		setTimeout(() => reject(new Error("stub start timeout")), 5000);
	});
}

function diagLogPath(pillow: string): string {
	const day = readdirSync(join(pillow, "logs"))[0] ?? "";
	const dayDir = join(pillow, "logs", day);
	return join(dayDir, readdirSync(dayDir)[0] ?? "");
}

function readDiagLog(pillow: string): { kind: string; [key: string]: unknown }[] {
	return readFileSync(diagLogPath(pillow), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { kind: string });
}

describe("@z-agent/cli diagnostics smoke", () => {
	it("--debug writes run.start/provider.*/loop.turn/run.end in order, redacted", async () => {
		const stub = await startStub();
		try {
			const pillow = mkdtempSync(join(tmpdir(), "z-smoke-diag-"));
			const result = runCli(["-p", "--debug", "--model", "stub-model", "say hi"], {
				OPENAI_API_KEY: "sk-test",
				OPENAI_BASE_URL: `http://127.0.0.1:${stub.port}`,
				OPENAI_CONTEXT_WINDOW: "200000",
				PILLOW_HOME: pillow,
			});
			expect(result.status).toBe(0);
			const raw = readFileSync(diagLogPath(pillow), "utf8");
			const records = readDiagLog(pillow);
			expect(records.map((r) => r.kind)).toEqual([
				"run.start",
				"provider.request",
				"provider.response",
				"loop.turn",
				"run.end",
			]);
			expect(records[0]).toMatchObject({ mode: "print", model: "stub-model", api: "openai-responses" });
			expect(records[4]).toMatchObject({ exitCode: 0, turns: 1 });
			expect(raw).not.toContain("sk-test");
		} finally {
			stub.stop();
		}
	});

	it("creates no logs dir without --debug", async () => {
		const stub = await startStub();
		try {
			const pillow = mkdtempSync(join(tmpdir(), "z-smoke-nodiag-"));
			const result = runCli(["-p", "--model", "stub-model", "say hi"], {
				OPENAI_API_KEY: "sk-test",
				OPENAI_BASE_URL: `http://127.0.0.1:${stub.port}`,
				OPENAI_CONTEXT_WINDOW: "200000",
				PILLOW_HOME: pillow,
			});
			expect(result.status).toBe(0);
			expect(existsSync(join(pillow, "logs"))).toBe(false);
		} finally {
			stub.stop();
		}
	});
});
