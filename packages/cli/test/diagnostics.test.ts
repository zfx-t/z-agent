import type { AgentEvent, AgentMessage, AssistantMessage, ToolResultMessage, Usage } from "@z-agent/agent";
import { describe, expect, it } from "vitest";
import {
	createDiagnostics,
	type DiagnosticsDirEntry,
	type DiagnosticsFs,
	type DiagnosticsRecord,
	logPathFor,
	redact,
	resolveDiagnosticsMode,
	rotateLogs,
} from "../src/diagnostics.ts";
import { pillowLogsDir } from "../src/pillow-home.ts";

// ---------------------------------------------------------------------------
// In-memory fs double + event fixtures
// ---------------------------------------------------------------------------

interface FakeFile {
	content: string;
	mode?: number;
}

function parentOf(path: string): string {
	const index = path.lastIndexOf("/");
	return index <= 0 ? "/" : path.slice(0, index);
}

function createFakeFs(seed: { dirs?: string[]; files?: Record<string, string> } = {}) {
	const dirs = new Set(seed.dirs ?? []);
	const files = new Map<string, FakeFile>(
		Object.entries(seed.files ?? {}).map(([path, content]) => [path, { content }]),
	);
	const calls: string[] = [];
	const fs: DiagnosticsFs = {
		mkdir: async (path, options) => {
			calls.push(`mkdir:${path}:${options.mode.toString(8)}`);
			let current = path;
			while (current && !dirs.has(current)) {
				dirs.add(current);
				current = parentOf(current);
			}
		},
		appendFile: async (path, data) => {
			calls.push(`append:${path}`);
			const file = files.get(path) ?? { content: "" };
			file.content += data;
			files.set(path, file);
		},
		readdir: async (path) => {
			if (!dirs.has(path)) {
				throw new Error(`ENOENT: no such directory ${path}`);
			}
			const entries: DiagnosticsDirEntry[] = [];
			for (const dir of dirs) {
				if (dir !== path && parentOf(dir) === path) {
					const name = dir.slice(path.length + 1);
					entries.push({ name, isDirectory: () => true });
				}
			}
			for (const file of files.keys()) {
				if (parentOf(file) === path) {
					const name = file.slice(path.length + 1);
					entries.push({ name, isDirectory: () => false });
				}
			}
			return entries;
		},
		rm: async (path) => {
			calls.push(`rm:${path}`);
			dirs.delete(path);
			for (const dir of [...dirs]) {
				if (dir.startsWith(`${path}/`)) {
					dirs.delete(dir);
				}
			}
			for (const file of [...files.keys()]) {
				if (file === path || file.startsWith(`${path}/`)) {
					files.delete(file);
				}
			}
		},
		chmod: async (path, mode) => {
			calls.push(`chmod:${path}:${mode.toString(8)}`);
			const file = files.get(path);
			if (file) {
				file.mode = mode;
			}
		},
	};
	return { fs, calls, dirs, files };
}

function usage(input = 3, output = 2): Usage {
	return {
		input,
		output,
		cacheRead: 1,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistantMessage(over: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "hello" }],
		api: "openai-responses",
		provider: "openai",
		model: "m1",
		usage: usage(),
		stopReason: "stop",
		timestamp: 1,
		...over,
	};
}

function userMessage(text = "hi"): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function toolResultMessage(text = "done"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "c1",
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 2,
	};
}

function readRecords(files: Map<string, FakeFile>, path: string): DiagnosticsRecord[] {
	const content = files.get(path)?.content ?? "";
	return content
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as DiagnosticsRecord);
}

function kinds(records: DiagnosticsRecord[]): string[] {
	return records.map((record) => record.kind);
}

// ---------------------------------------------------------------------------
// Task 1: redaction, path layout, rotation, mode resolution
// ---------------------------------------------------------------------------

describe("redact", () => {
	it("redacts secret-shaped keys recursively", () => {
		expect(redact({ apiKey: "x", nested: { Authorization: "Bearer y" }, ok: 1 })).toEqual({
			apiKey: "[redacted]",
			nested: { Authorization: "[redacted]" },
			ok: 1,
		});
	});

	it("covers the documented key and value patterns", () => {
		expect(
			redact({
				api_key: "a",
				"X-API-KEY": "b",
				accessToken: "c",
				session_secret: "d",
				dbPassword: "e",
				token: "f",
			}),
		).toEqual({
			api_key: "[redacted]",
			"X-API-KEY": "[redacted]",
			accessToken: "[redacted]",
			session_secret: "[redacted]",
			dbPassword: "[redacted]",
			token: "[redacted]",
		});
	});

	it("does not redact keys that merely contain a pattern substring", () => {
		expect(redact({ estTokens: 42, totalTokens: 7, tokens: 3, input: 5 })).toEqual({
			estTokens: 42,
			totalTokens: 7,
			tokens: 3,
			input: 5,
		});
	});

	it("redacts secret-shaped string values and array elements", () => {
		expect(redact({ v: "sk-abcdefghijklmnop" })).toEqual({ v: "[redacted]" });
		expect(redact({ v: "ghp_0123456789abcdef" })).toEqual({ v: "ghp_0123456789abcdef" });
		expect(redact({ v: "ghp-0123456789abcdef" })).toEqual({ v: "[redacted]" });
		expect(redact(["sk-ant-0123456789", "plain"])).toEqual(["[redacted]", "plain"]);
		expect(redact({ list: [{ token: "t" }, "xoxb-1234567890"] })).toEqual({
			list: [{ token: "[redacted]" }, "[redacted]"],
		});
	});

	it("redacts secrets embedded mid-string without eating lookalikes", () => {
		expect(redact({ errorMessage: "HTTP 401: invalid key sk-abcdefghijklmnop, retry" })).toEqual({
			errorMessage: "HTTP 401: invalid key [redacted], retry",
		});
		expect(redact({ v: "Bearer ghp-0123456789abcdef" })).toEqual({ v: "Bearer [redacted]" });
		expect(redact({ v: "ask-user-for-input" })).toEqual({ v: "ask-user-for-input" });
		expect(redact({ v: "sk-short" })).toEqual({ v: "sk-short" });
	});

	it("leaves primitives and non-plain objects untouched", () => {
		const date = new Date(0);
		expect(redact(5)).toBe(5);
		expect(redact("hello")).toBe("hello");
		expect(redact(null)).toBe(null);
		expect(redact({ when: date }).when).toBe(date);
	});

	it("marks cycles instead of recursing forever", () => {
		const value: { self?: unknown } = {};
		value.self = value;
		expect(redact(value)).toEqual({ self: "[circular]" });
	});
});

describe("logPathFor / pillowLogsDir", () => {
	it("nests session logs under a local day directory", () => {
		expect(logPathFor("/l", "s1", new Date(2026, 8, 12, 10))).toBe("/l/2026-09-12/s1.jsonl");
		expect(pillowLogsDir("/h/.pillow")).toBe("/h/.pillow/logs");
	});
});

describe("rotateLogs", () => {
	const now = new Date(2026, 8, 12, 12);

	it("removes day dirs older than keepDays and trims today to the newest files", async () => {
		const files: Record<string, string> = {
			"/l/notes.txt": "keep",
			"/l/2026-09-01/old.jsonl": "x",
			"/l/2026-09-12/keep.txt": "keep",
		};
		for (let i = 0; i < 55; i++) {
			files[`/l/2026-09-12/s${String(i).padStart(2, "0")}.jsonl`] = "{}";
		}
		const fake = createFakeFs({
			dirs: ["/l", "/l/2026-09-01", "/l/2026-09-10", "/l/2026-09-12", "/l/random-dir"],
			files,
		});
		await rotateLogs("/l", now, fake.fs);
		expect(fake.calls).toContain("rm:/l/2026-09-01");
		expect(fake.dirs.has("/l/2026-09-10")).toBe(true);
		expect(fake.dirs.has("/l/random-dir")).toBe(true);
		expect(fake.files.has("/l/notes.txt")).toBe(true);
		expect(fake.files.has("/l/2026-09-12/keep.txt")).toBe(true);
		const remaining = [...fake.files.keys()].filter(
			(path) => path.startsWith("/l/2026-09-12/") && path.endsWith(".jsonl"),
		);
		expect(remaining).toHaveLength(50);
		expect(remaining).not.toContain("/l/2026-09-12/s00.jsonl");
		expect(remaining).toContain("/l/2026-09-12/s54.jsonl");
	});

	it("keeps the 7-day boundary dir and removes the 8-day one", async () => {
		const fake = createFakeFs({
			dirs: ["/l", "/l/2026-09-05", "/l/2026-09-04", "/l/2026-09-12"],
		});
		await rotateLogs("/l", now, fake.fs);
		expect(fake.dirs.has("/l/2026-09-05")).toBe(true);
		expect(fake.dirs.has("/l/2026-09-04")).toBe(false);
	});

	it("ignores non-matching day names and survives a missing logs dir", async () => {
		const fake = createFakeFs({
			dirs: ["/l", "/l/2026-9-1", "/l/not-a-day", "/l/2026-09-12"],
			files: { "/l/2026-9-1/x.jsonl": "{}" },
		});
		await rotateLogs("/l", now, fake.fs);
		expect(fake.dirs.has("/l/2026-9-1")).toBe(true);
		expect(fake.dirs.has("/l/not-a-day")).toBe(true);
		await expect(rotateLogs("/missing", now, fake.fs)).resolves.toBeUndefined();
	});
});

describe("resolveDiagnosticsMode", () => {
	it("flag wins, then PILLOW_DEBUG", () => {
		expect(resolveDiagnosticsMode(false, {})).toBe("off");
		expect(resolveDiagnosticsMode(false, { PILLOW_DEBUG: "1" })).toBe("on");
		expect(resolveDiagnosticsMode(false, { PILLOW_DEBUG: "verbose" })).toBe("verbose");
		expect(resolveDiagnosticsMode(true, { PILLOW_DEBUG: "verbose" })).toBe("on");
		expect(resolveDiagnosticsMode(true, {})).toBe("on");
		expect(resolveDiagnosticsMode(false, { PILLOW_DEBUG: "0" })).toBe("off");
		expect(resolveDiagnosticsMode(false, { PILLOW_DEBUG: "garbage" })).toBe("off");
	});
});

// ---------------------------------------------------------------------------
// Task 2: sink + AgentEvent mapping
// ---------------------------------------------------------------------------

describe("createDiagnostics", () => {
	it("is a true no-op when off", async () => {
		const fake = createFakeFs();
		const diag = createDiagnostics({ mode: "off", logsDir: "/l", sessionId: "s1", fs: fake.fs });
		expect(diag.enabled).toBe(false);
		expect(diag.path).toBeUndefined();
		diag.log("run.start", { mode: "print" });
		diag.onAgentEvent({ type: "turn_start" });
		await diag.flush();
		expect(fake.calls).toEqual([]);
	});

	it("writes JSONL records: mkdir 0700, chmod 0600 once, seq increments", async () => {
		const fake = createFakeFs({ dirs: ["/l"] });
		const diag = createDiagnostics({
			mode: "on",
			logsDir: "/l",
			sessionId: "s1",
			now: () => new Date(2026, 8, 12, 10),
			fs: fake.fs,
		});
		expect(diag.enabled).toBe(true);
		expect(diag.path).toBe("/l/2026-09-12/s1.jsonl");
		diag.log("run.start", { mode: "print", apiKey: "sk-live-key-123456" });
		diag.log("custom", { note: "ok" });
		await diag.flush();
		expect(fake.calls.filter((c) => c.startsWith("mkdir"))).toEqual(["mkdir:/l/2026-09-12:700"]);
		expect(fake.calls.filter((c) => c.startsWith("chmod"))).toEqual(["chmod:/l/2026-09-12/s1.jsonl:600"]);
		const records = readRecords(fake.files, "/l/2026-09-12/s1.jsonl");
		expect(kinds(records)).toEqual(["run.start", "custom"]);
		expect(records[0]).toMatchObject({ seq: 1, sessionId: "s1", mode: "print", apiKey: "[redacted]" });
		expect(records[0]?.ts).toBe(new Date(2026, 8, 12, 10).toISOString());
		expect(records[1]).toMatchObject({ seq: 2, note: "ok" });
	});

	it("warns once on write failure and keeps accepting later records", async () => {
		const fake = createFakeFs({ dirs: ["/l"] });
		const warnings: string[] = [];
		let failAppends = 1;
		const inner = fake.fs.appendFile;
		fake.fs.appendFile = async (path, data) => {
			if (failAppends > 0) {
				failAppends -= 1;
				throw new Error("disk full");
			}
			return inner(path, data);
		};
		const diag = createDiagnostics({
			mode: "on",
			logsDir: "/l",
			sessionId: "s1",
			now: () => new Date(2026, 8, 12, 10),
			fs: fake.fs,
			warn: (line) => warnings.push(line),
		});
		diag.log("first", {});
		diag.log("second", {});
		await diag.flush();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("disk full");
		expect(kinds(readRecords(fake.files, "/l/2026-09-12/s1.jsonl"))).toEqual(["second"]);
	});

	it("rotates old logs at creation", async () => {
		const fake = createFakeFs({
			dirs: ["/l", "/l/2026-09-01", "/l/2026-09-12"],
			files: { "/l/2026-09-01/old.jsonl": "{}" },
		});
		const diag = createDiagnostics({
			mode: "on",
			logsDir: "/l",
			sessionId: "s1",
			now: () => new Date(2026, 8, 12, 10),
			fs: fake.fs,
		});
		await diag.flush();
		expect(fake.dirs.has("/l/2026-09-01")).toBe(false);
	});
});

describe("onAgentEvent mapping", () => {
	function feed(diag: ReturnType<typeof createDiagnostics>, events: AgentEvent[]): void {
		for (const event of events) {
			diag.onAgentEvent(event);
		}
	}

	function toolTurnEvents(): AgentEvent[] {
		return [
			{ type: "turn_start" },
			{ type: "message_start", message: userMessage() },
			{ type: "message_end", message: userMessage() },
			{
				type: "message_start",
				message: assistantMessage({ content: [], stopReason: "pending" }),
			},
			{
				type: "message_end",
				message: assistantMessage({
					content: [
						{ type: "text", text: "hello" },
						{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
					],
					stopReason: "toolUse",
				}),
			},
			{ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "a.ts", content: "s" } },
			{
				type: "tool_execution_end",
				toolCallId: "c1",
				toolName: "read",
				result: { content: [{ type: "text", text: "done" }], details: {} },
				isError: false,
			},
			{ type: "message_start", message: toolResultMessage() },
			{ type: "message_end", message: toolResultMessage() },
			{
				type: "turn_end",
				message: assistantMessage({
					content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } }],
					stopReason: "toolUse",
				}),
				toolResults: [toolResultMessage()],
			},
		];
	}

	it("maps a full tool turn into provider/tool/loop records", async () => {
		let nowMs = new Date(2026, 8, 12, 10).getTime();
		const fake = createFakeFs({ dirs: ["/l"] });
		const diag = createDiagnostics({
			mode: "on",
			logsDir: "/l",
			sessionId: "s1",
			now: () => new Date(nowMs),
			fs: fake.fs,
			thinkingLevel: () => "high",
		});
		diag.onAgentEvent({ type: "agent_start" });
		const events = toolTurnEvents();
		for (const event of events) {
			nowMs += 25;
			diag.onAgentEvent(event);
		}
		diag.onAgentEvent({ type: "agent_end", messages: [] });
		await diag.flush();
		const records = readRecords(fake.files, diag.path ?? "");
		expect(kinds(records)).toEqual(["provider.request", "provider.response", "tool.start", "tool.end", "loop.turn"]);
		expect(records[0]).toMatchObject({
			turn: 1,
			model: "m1",
			api: "openai-responses",
			messages: 1,
			thinking: "high",
		});
		expect(typeof records[0]?.estTokens).toBe("number");
		expect(records[0]?.estTokens).toBeGreaterThan(0);
		expect(records[1]).toMatchObject({
			turn: 1,
			stopReason: "toolUse",
			durationMs: 25,
			usage: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0 },
		});
		expect(records[1]).not.toHaveProperty("textChars");
		expect(records[2]).toMatchObject({ toolCallId: "c1", name: "read", argKeys: ["path", "content"] });
		expect(records[2]).not.toHaveProperty("args");
		expect(records[3]).toMatchObject({
			toolCallId: "c1",
			name: "read",
			durationMs: 25,
			isError: false,
			outputChars: 4,
		});
		expect(records[4]).toMatchObject({ turn: 1, hasToolCalls: true, steeringDrained: 0, followUpDrained: 0 });
	});

	it("never serialises tool argument values or message text", async () => {
		const fake = createFakeFs({ dirs: ["/l"] });
		const diag = createDiagnostics({
			mode: "verbose",
			logsDir: "/l",
			sessionId: "s1",
			now: () => new Date(2026, 8, 12, 10),
			fs: fake.fs,
		});
		feed(diag, [{ type: "agent_start" }, ...toolTurnEvents(), { type: "agent_end", messages: [] }]);
		await diag.flush();
		const raw = fake.files.get(diag.path ?? "")?.content ?? "";
		expect(raw).not.toContain("a.ts");
		expect(raw).not.toContain("hello");
		expect(raw).not.toContain('"text"');
		const records = readRecords(fake.files, diag.path ?? "");
		expect(records[1]).toMatchObject({ textChars: 5 });
		expect(records[2]).toMatchObject({ argsChars: JSON.stringify({ path: "a.ts", content: "s" }).length });
	});

	it("reports stopReason error with errorMessage", async () => {
		const fake = createFakeFs({ dirs: ["/l"] });
		const diag = createDiagnostics({
			mode: "on",
			logsDir: "/l",
			sessionId: "s1",
			now: () => new Date(2026, 8, 12, 10),
			fs: fake.fs,
		});
		const failed = assistantMessage({ stopReason: "error", errorMessage: "Stream idle for 120s" });
		feed(diag, [
			{ type: "agent_start" },
			{ type: "turn_start" },
			{ type: "message_start", message: userMessage() },
			{ type: "message_end", message: userMessage() },
			{ type: "message_start", message: assistantMessage({ content: [], stopReason: "pending" }) },
			{ type: "message_end", message: failed },
			{ type: "turn_end", message: failed, toolResults: [] },
			{ type: "agent_end", messages: [] },
		]);
		await diag.flush();
		const records = readRecords(fake.files, diag.path ?? "");
		expect(records[1]).toMatchObject({ stopReason: "error", errorMessage: "Stream idle for 120s" });
		expect(records[2]).toMatchObject({ kind: "loop.turn", hasToolCalls: false });
	});

	it("attributes injected user messages to steering after tool turns and follow-up otherwise", async () => {
		const fake = createFakeFs({ dirs: ["/l"] });
		const diag = createDiagnostics({
			mode: "on",
			logsDir: "/l",
			sessionId: "s1",
			now: () => new Date(2026, 8, 12, 10),
			fs: fake.fs,
		});
		const assistant = assistantMessage();
		feed(diag, [
			{ type: "agent_start" },
			...toolTurnEvents(),
			// turn 2: a steering message drained after the tool turn
			{ type: "turn_start" },
			{ type: "message_start", message: userMessage("steer") },
			{ type: "message_end", message: userMessage("steer") },
			{ type: "message_start", message: assistantMessage({ content: [], stopReason: "pending" }) },
			{ type: "message_end", message: assistant },
			{ type: "turn_end", message: assistant, toolResults: [] },
			// turn 3: a queued message after a no-tool turn (follow-up poll path)
			{ type: "turn_start" },
			{ type: "message_start", message: userMessage("more") },
			{ type: "message_end", message: userMessage("more") },
			{ type: "message_start", message: assistantMessage({ content: [], stopReason: "pending" }) },
			{ type: "message_end", message: assistant },
			{ type: "turn_end", message: assistant, toolResults: [] },
			{ type: "agent_end", messages: [] },
		]);
		await diag.flush();
		const turns = readRecords(fake.files, diag.path ?? "").filter((r) => r.kind === "loop.turn");
		expect(turns).toHaveLength(3);
		expect(turns[1]).toMatchObject({ turn: 2, hasToolCalls: false, steeringDrained: 1, followUpDrained: 0 });
		expect(turns[2]).toMatchObject({ turn: 3, steeringDrained: 0, followUpDrained: 1 });
	});

	it("redacts secret-shaped fields on synthetic records", async () => {
		const fake = createFakeFs({ dirs: ["/l"] });
		const diag = createDiagnostics({
			mode: "on",
			logsDir: "/l",
			sessionId: "s1",
			now: () => new Date(2026, 8, 12, 10),
			fs: fake.fs,
		});
		diag.log("custom", { detail: { apiKey: "x", list: ["sk-abcdefghijkl"] }, keep: 1 });
		await diag.flush();
		const records = readRecords(fake.files, diag.path ?? "");
		expect(records[0]?.detail).toEqual({ apiKey: "[redacted]", list: ["[redacted]"] });
		expect(records[0]?.keep).toBe(1);
	});
});
