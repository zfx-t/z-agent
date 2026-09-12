# Diagnostics Log and Crash Guard Implementation Plan (Loop D)

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task closes its own loop: failing test → implementation → focused test → `npm run check` → note in the evidence file.

**Goal:** When an operator says "it hung" or "it crashed and my terminal is garbage", there is a file to look at and the terminal is intact. Today `packages/cli/src` has no logger, and the only crash handler is `main().catch` in `cli.ts` — an `unhandledRejection` or `uncaughtException` inside the TUI leaves the alt-screen / bracketed-paste / hidden-cursor state on and loses the unsaved session tail.

**Architecture:** Two new pure-ish modules in `@z-agent/cli`: `diagnostics.ts` (structured JSONL event sink with redaction, opened only when enabled) and `crash-guard.ts` (ordered shutdown: restore terminal → persist session with a deadline → write crash record → print one line → exit). Both are built from injected dependencies so tests never touch `process` or real files. Event sources are the existing `agent.subscribe` (non-effect), the `onRetry` callback from Loop A (soft dependency; guarded by `typeof`), tool wrappers, and compaction. `@z-agent/agent`, `@z-agent/ai`, `@z-agent/tui` do not gain logging code; the TUI only needs `TuiSession.close()` to be idempotent (it already is).

**Tech Stack:** TypeScript 5.9 (erasable syntax), Node.js 22+, `node:fs`, Vitest, Biome. No new dependencies.

## Outcome Contract

```text
User: Coding-agent operator diagnosing a hang, a slow turn, or a crash; and the maintainer reading their bug report
Trigger / real entrypoint: `z-agent --debug` or `PILLOW_DEBUG=1` (TUI and `-p`); crash guard is always installed
Primary journey: run with --debug → `/status` shows `log: ~/.pillow/logs/2026-09-12/<sessionId>.jsonl` → file has provider.request / provider.response / tool.start / tool.end / loop.turn / compaction records with durations and usage; throw inside an extension → terminal restored, session JSONL flushed, one stderr line `z-agent crashed: <message> (log: <path>)`, exit 1
Observable success: log lines are valid JSON, contain no apiKey/Authorization values and no message text unless PILLOW_DEBUG=verbose; after a simulated uncaughtException the injected `restoreTerminal` ran before `persistSession`, `persistSession` was bounded by 2s, and `exit(1)` was called exactly once
Non-goals: remote telemetry; metrics aggregation; log viewing UI; log levels beyond info/debug; logging inside @z-agent/agent or @z-agent/ai; Windows event log
Constraints and dependencies: files 0600 in ~/.pillow/logs; rotation deletes only files matching the log naming pattern; SigintAbort semantics (abort → second Ctrl-C exits 130) unchanged; print mode --verbose output unchanged
Proof method: `packages/cli/test/diagnostics.test.ts`, `packages/cli/test/crash-guard.test.ts`, small additions in `smoke.test.ts` / `interactive.test.ts`; `npm run check`; live transcript in docs/evidence/diagnostics-crash-acceptance.txt
```

## Global Constraints

- Node `>=22`; no dependency changes.
- Erasable TypeScript only; relative imports with `.ts`.
- No new imports of `node:fs` / `node:process` in `@z-agent/agent`, `@z-agent/ai`, `@z-agent/tui`.
- Never log `apiKey`, `Authorization`, `x-api-key`, env values, tool arguments for `write`/`edit` contents, or assistant/user text by default.
- Disabled diagnostics must be a true no-op: no directory creation, no file handle, `log()` returns synchronously.
- Do not create commits unless the user explicitly asks.

---

## File Map

| File | Responsibility |
| --- | --- |
| Create `packages/cli/src/diagnostics.ts` | `DiagnosticsEvent` union, `redact()`, `createDiagnostics()` (JSONL sink, buffered `appendFile`, `flush()`), `logPathFor()`, `rotateLogs()`, `summarizeAgentEvent()` mapper from `AgentEvent` to diagnostics records. |
| Create `packages/cli/test/diagnostics.test.ts` | Redaction, no-op when disabled, path/date layout, 0600, rotation keeps N newest and only touches `*.jsonl`, event mapping for each `AgentEvent` type, verbose mode includes text length not text. |
| Create `packages/cli/src/crash-guard.ts` | `createCrashGuard(deps)` → `{ install(proc), handle(kind, error), uninstall() }`; ordered shutdown with deadline; re-entrancy latch. |
| Create `packages/cli/test/crash-guard.test.ts` | Order of operations, persist deadline, double-fault handling, SIGTERM/SIGHUP paths, exit code, message format, uninstall removes listeners (fake `EventEmitter` as `proc`). |
| Modify `packages/cli/src/args.ts` | `--debug`; help text; `PILLOW_DEBUG` env read in `cli.ts`, not here. |
| Modify `packages/cli/src/pillow-home.ts` | `pillowLogsDir(userPillow)`. |
| Modify `packages/cli/src/cli.ts` | Create diagnostics (enabled by flag/env), `agent.subscribe(diag.onAgentEvent)`, wire `onRetry` when present, wrap `runPrint`/`runInteractive` with the crash guard, replace `main().catch` with `guard.handle("main", err)`, `/status` log path line, `diag.flush()` on normal exit. |
| Modify `packages/cli/src/compaction.ts` | Optional `onCompaction?: (info) => void` hook parameter (pure callback, no import of diagnostics). |
| Modify `packages/cli/src/model-settings.ts` | `formatRuntimeStatus` accepts optional `logPath`. |
| Modify `packages/cli/test/args.test.ts`, `model-settings.test.ts`, `pillow-home.test.ts`, `compaction.test.ts` | Flag, status line, logs dir, compaction hook. |
| Modify `packages/tui/src/session.ts` | None expected; add a test asserting `close()` is idempotent and writes `LEAVE_ALT` once (`packages/tui/test/tui.test.ts`). |
| Create `docs/adr/0031-diagnostics-crash-guard.md`; modify `docs/adr/README.md`, `docs/roadmap.md`, `docs/glossary.md`, `packages/cli/README.md` | Record decision; define `diagnostics record`, `crash guard`. |

## Locked Product Decisions

1. **Enable:** `--debug` flag or `PILLOW_DEBUG=1|verbose`. Flag wins. `verbose` adds `textChars` / `argsChars` lengths and tool names' argument keys — never values or text.
2. **Location:** `~/.pillow/logs/<YYYY-MM-DD>/<sessionId>.jsonl`, directories `0700`, files `0600`. Print mode uses the same layout (`sessionId` exists in print mode already; if not, `print-<pid>`).
3. **Rotation:** at diagnostics creation, delete day-directories older than 7 days and, within the current day, keep the newest 50 `*.jsonl`. Only paths under `pillowLogsDir` matching `/^\d{4}-\d{2}-\d{2}$/` and `*.jsonl` are ever removed.
4. **Record shape:** `{ ts: ISO string, seq: number, kind: string, sessionId, ...fields }`. Kinds and mandatory fields:
   - `run.start` `{ mode: "tui"|"print", model, api, cwd, durable, version }`
   - `provider.request` `{ turn, model, api, messages, estTokens, thinking }`
   - `provider.retry` `{ attempt, maxAttempts, delayMs, reason }` (Loop A)
   - `provider.response` `{ turn, stopReason, durationMs, usage: { input, output, cacheRead, cacheWrite }, errorMessage? }`
   - `tool.start` `{ toolCallId, name, argKeys[] }`
   - `tool.end` `{ toolCallId, name, durationMs, isError, outputChars }`
   - `loop.turn` `{ turn, hasToolCalls, steeringDrained, followUpDrained }`
   - `compaction` `{ dropped, kept, estBefore, estAfter, reason: "threshold"|"length" }`
   - `crash` `{ source: "uncaughtException"|"unhandledRejection"|"main"|"SIGTERM"|"SIGHUP", message, stack?, terminalRestored, sessionPersisted }`
   - `run.end` `{ exitCode, turns, durationMs }`
5. **Redaction:** recursive over any object passed to `log()`: keys matching `/api[-_]?key|authorization|x-api-key|token|secret|password/i` → `"[redacted]"`; strings matching `/^(sk|sk-ant|ghp|gho|xox[abp])-[A-Za-z0-9_-]{8,}/` → `"[redacted]"`. Applied even in verbose mode.
6. **Crash order (fixed):** (a) latch; (b) `restoreTerminal()` (calls `TuiSession.close()` when a TUI exists; no-op in print); (c) `persistSession()` raced against a 2 000 ms deadline; (d) `diag.log({kind:"crash",…})` + `flush()` with its own 500 ms deadline; (e) `stderr` one line: `z-agent crashed: <message>` plus ` (log: <path>)` when diagnostics enabled, or ` (rerun with --debug for a log)` when not; (f) `exit(1)`. A second fault during (b)–(e) skips to (e)/(f). `unhandledRejection` with a non-Error reason is wrapped in `Error(String(reason))`.
7. **Signals:** `SIGTERM` and `SIGHUP` go through the same guard with exit code `143` / `129` and `kind: "crash"` `source` set accordingly; `SIGINT` remains owned by `SigintAbort` (unchanged).
8. **Normal exit:** `run.end` logged and `flush()` awaited before `process.exit` in both modes; the guard is uninstalled after the run so late rejections from test doubles do not re-trigger it.
9. **No changes to what `--verbose` prints** in print mode; `--debug` may be combined with it.

## Contract Map

```ts
// packages/cli/src/diagnostics.ts
export type DiagnosticsMode = "off" | "on" | "verbose";
export interface DiagnosticsRecord { ts: string; seq: number; kind: string; sessionId: string; [key: string]: unknown; }
export interface DiagnosticsDeps {
	mode: DiagnosticsMode;
	logsDir: string;             // pillowLogsDir(userPillow)
	sessionId: string;
	now?: () => Date;
	fs?: { mkdir: typeof import("node:fs/promises").mkdir; appendFile: typeof import("node:fs/promises").appendFile; readdir: typeof import("node:fs/promises").readdir; rm: typeof import("node:fs/promises").rm; chmod: typeof import("node:fs/promises").chmod; };
}
export interface Diagnostics {
	readonly enabled: boolean;
	readonly mode: DiagnosticsMode;
	readonly path?: string;
	log(kind: string, fields?: Record<string, unknown>): void;   // sync enqueue
	onAgentEvent(event: AgentEvent): void;                        // maps + logs
	flush(): Promise<void>;
}
export function redact<T>(value: T): T;
export function logPathFor(logsDir: string, sessionId: string, now: Date): string;
export function rotateLogs(logsDir: string, now: Date, fs: DiagnosticsDeps["fs"], keepDays?: number, keepFiles?: number): Promise<void>;
export function resolveDiagnosticsMode(flag: boolean, env: NodeJS.ProcessEnv): DiagnosticsMode;
export function createDiagnostics(deps: DiagnosticsDeps): Diagnostics;
```

Note on `fs` typing: declare the five function types explicitly (`(path: string, …) => Promise<…>`) instead of `typeof import(...)` — the project bans inline `import()` types. Shown here only as shorthand.

```ts
// packages/cli/src/crash-guard.ts
export type CrashSource = "uncaughtException" | "unhandledRejection" | "main" | "SIGTERM" | "SIGHUP";
export interface CrashGuardDeps {
	restoreTerminal: () => void;
	persistSession: () => Promise<void>;
	log: (fields: Record<string, unknown>) => void;
	flush: () => Promise<void>;
	stderr: (line: string) => void;
	exit: (code: number) => void;
	logPath?: string;
	persistDeadlineMs?: number; // 2000
	flushDeadlineMs?: number;   // 500
	setTimeout?: typeof globalThis.setTimeout;
	clearTimeout?: typeof globalThis.clearTimeout;
}
export interface ProcessLike { on(event: string, listener: (...args: never[]) => void): unknown; off(event: string, listener: (...args: never[]) => void): unknown; }
export interface CrashGuard {
	install(proc: ProcessLike): void;
	uninstall(): void;
	handle(source: CrashSource, error: unknown): Promise<void>;
}
export function exitCodeFor(source: CrashSource): number; // 1 | 143 | 129
export function createCrashGuard(deps: CrashGuardDeps): CrashGuard;
```

```ts
// packages/cli/src/pillow-home.ts
export function pillowLogsDir(userPillow: string): string; // join(userPillow, "logs")
// packages/cli/src/args.ts
export interface CliArgs { /* … */ debug: boolean; }
// packages/cli/src/compaction.ts
export interface CompactionInfo { dropped: number; kept: number; estBefore: number; estAfter: number; reason: "threshold" | "length"; }
```

---

### Task 1: Redaction, path layout, rotation

**Files:** Create `diagnostics.ts` (partial), `diagnostics.test.ts`; modify `pillow-home.ts`, `pillow-home.test.ts`.

- [ ] **Step 1: Failing tests** — `redact({ apiKey: "x", nested: { Authorization: "Bearer y" }, ok: 1 })` → both redacted, `ok` intact; a string value `"sk-abcdefghijklmnop"` → `"[redacted]"`; `logPathFor("/l", "s1", new Date("2026-09-12T10:00:00Z"))` → `/l/2026-09-12/s1.jsonl`; `rotateLogs` with an in-memory fs double: removes `2026-09-01` dir (>7 days), keeps `2026-09-10`, ignores `notes.txt` and `random-dir`, trims today's `*.jsonl` to 50 newest by name; `pillowLogsDir("/h/.pillow") === "/h/.pillow/logs"`.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run** focused tests, `npm run check`.

### Task 2: Diagnostics sink and AgentEvent mapping

**Files:** Modify `diagnostics.ts`, `diagnostics.test.ts`.

- [ ] **Step 1: Failing tests** — `mode: "off"` → `enabled === false`, `path === undefined`, `log()` and `flush()` never call `fs`; `mode: "on"` → first `log` triggers `mkdir` (0700) and `appendFile` of one JSON line + `chmod` 0600 once; `seq` increments; `flush()` resolves after pending appends; mapping: `message_start` for assistant → `provider.request` only once per turn (paired with `turn_start`), `message_end` for assistant → `provider.response` with `durationMs` from the matching request and `usage` copied; `tool_execution_start/end` → `tool.start/end` with `argKeys` and `outputChars`, never `args` values; `turn_end` → `loop.turn`; in `verbose` mode `provider.response.textChars` present, `text` absent; a synthetic event with `apiKey` in details is redacted.
- [ ] **Step 2: Implement** — internal `queue: Promise<void>` chain for appends (`appendFile` serialised, errors swallowed after first `stderr` warning to avoid crash loops); per-turn timing map keyed by turn index.
- [ ] **Step 3: Run** focused tests, `npm run check`.

### Task 3: Crash guard

**Files:** Create `crash-guard.ts`, `crash-guard.test.ts`; add `close()` idempotency test in `packages/tui/test/tui.test.ts`.

- [ ] **Step 1: Failing tests** — `handle("uncaughtException", new Error("boom"))` calls deps in order `restoreTerminal, persistSession, log, flush, stderr, exit(1)` (record with an array); `persistSession` that never resolves → `exit` still called after the 2 000 ms deadline (fake timers) and `log` fields include `sessionPersisted: false`; `restoreTerminal` throwing → still persists and exits; second `handle` while first is in flight → only `stderr` + `exit`, no second `persistSession`; `install(fakeProc)` registers `uncaughtException`, `unhandledRejection`, `SIGTERM`, `SIGHUP` and `uninstall` removes exactly those; `handle("SIGTERM")` exits 143, `("SIGHUP")` 129; non-Error rejection reason → message `String(reason)`; stderr line format matches decision 6 with and without `logPath`; `TuiSession.close()` twice writes `LEAVE_ALT` once.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run** focused tests, `npm run check`.

### Task 4: CLI wiring

**Files:** Modify `args.ts`, `cli.ts`, `compaction.ts`, `model-settings.ts`; tests `args.test.ts`, `compaction.test.ts`, `model-settings.test.ts`, `smoke.test.ts`.

- [ ] **Step 1: Failing tests** — `parseArgs(["--debug"]).debug === true`; help lists it; `resolveDiagnosticsMode(false, { PILLOW_DEBUG: "verbose" }) === "verbose"`, flag `true` + env unset → `"on"`; `compact()` invokes `onCompaction` with the info object; `formatRuntimeStatus({ …, logPath })` prints `log: <path>`; smoke: `-p --yes --debug` against the scripted StreamFn used by existing smoke tests writes a file under a temp `HOME` containing `run.start`, `provider.request`, `provider.response`, `run.end` in order.
- [ ] **Step 2: Implement** — in `cli.ts`: `const diag = createDiagnostics({ mode: resolveDiagnosticsMode(args.debug, process.env), logsDir: pillowLogsDir(userPillow), sessionId })`; `agent.subscribe(diag.onAgentEvent)`; Loop A hook: `onRetry: (e) => diag.log("provider.retry", e)`; `const guard = createCrashGuard({ restoreTerminal: () => tuiSession?.close(), persistSession: persist, log: (f) => diag.log("crash", f), flush: diag.flush, stderr: (l) => process.stderr.write(l + "\n"), exit: (c) => process.exit(c), logPath: diag.path })`; `guard.install(process)` before the run, `guard.uninstall()` after `persist()`; `main().catch((err) => guard.handle("main", err))`.
- [ ] **Step 3: Run** focused tests, `npm run check`.

### Task 5: ADR, docs, evidence

- [ ] `docs/adr/0031-diagnostics-crash-guard.md` — Alternatives: `debug` npm package (rejected: dependency, unstructured), logging inside `@z-agent/agent` (rejected: ADR-0010 boundaries; subscribe is sufficient), OpenTelemetry (rejected for v0: weight; record shape kept OTel-mappable), `process.on("exit")` only (rejected: cannot await persist).
- [ ] Roadmap `Phase 3.4 — Diagnostics and crash guard`; glossary `diagnostics record`, `crash guard`, `redaction`.
- [ ] `packages/cli/README.md`: `--debug`, log location, retention, redaction rules, how to attach a log to a bug report.
- [ ] Evidence `docs/evidence/diagnostics-crash-acceptance.txt`: (1) `--debug -p --yes "list files"` → `head` of the log with values visibly redacted; (2) TUI with a throwaway extension whose command does `setTimeout(() => { throw new Error("boom") })` → terminal prompt is usable afterwards (`tput` sanity: `echo $?` prints 1, no stray escape state), the session file has the last turn, crash record present; (3) `kill -TERM <pid>` during a stream → exit 143 and `source: "SIGTERM"` record; (4) run without `--debug`: no `logs/` directory created (`ls ~/.pillow` before/after diff).

## Execution Loop (per task)

1. Red → 2. Green → 3. Focused vitest → 4. `npm run check` → 5. One-line evidence entry → next task.

## Whole-branch review checklist

- `grep -rn "node:fs\|process\." packages/agent/src packages/ai/src packages/tui/src` shows no new hits.
- `grep -n "content\b\|text:" packages/cli/src/diagnostics.ts` — assistant/user text never serialised.
- Every `setTimeout` in `crash-guard.ts` is cleared on the fast path (fake-timer test asserts `vi.getTimerCount() === 0`).
- `SigintAbort` file untouched; `EXIT_SIGINT` behaviour covered by existing `abort.test.ts` still green.
- Disabled mode: `fs` double records zero calls in the smoke test without `--debug`.
- ADR row, roadmap, glossary, README, evidence present.

## Risks

- `appendFile` on a slow disk during a tight tool loop: single-flight queue + swallow-after-warn keeps the agent loop unaffected; log lines may be lost, never block.
- `unhandledRejection` from third-party extension code that the extension author intended to ignore now terminates the process. This is deliberate for a production CLI; document it in the extension API notes (`packages/cli/README.md`).
