# Bash Tool Environment Scrub and Default Timeout Implementation Plan (Loop B)

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking. Every task closes its own loop: failing test → implementation → focused test → `npm run check` → note in the evidence file.

**Goal:** A model-issued `bash` command can no longer read the operator's provider credentials from its environment, and can no longer run forever when the model omits `timeout`.

**Architecture:** Add a pure `bash-env.ts` module in `@z-agent/agent` that derives the child environment from `process.env` under a policy (default: scrub secret-shaped variables). `createBashTool` gains `env` and `timeout` options; `runCommand` receives the scrubbed env and a resolved timeout. `@z-agent/cli` exposes two flags. No change to the tool schema's argument names; the `timeout` description changes to state the default and the cap. Effect boundary unchanged (the spawn still lives in `tool.execute`).

**Tech Stack:** TypeScript 5.9 (erasable syntax), Node.js 22+, Vitest, Biome. No new dependencies.

## Outcome Contract

```text
User: Coding-agent operator running z-agent in a shell that has OPENAI_API_KEY / ANTHROPIC_API_KEY / cloud credentials exported
Trigger / real entrypoint: any bash tool call from the TUI or `-p --yes`
Primary journey: model runs `env | grep -i key` → output has no *_API_KEY lines; model runs `sleep 100000` without timeout → tool result "Timed out after 600 seconds" and the process tree is killed
Observable success: `printenv OPENAI_API_KEY` exits 1 inside the tool while `printenv PATH` and `HOME` still work; a tool call with no timeout ends at the default; a tool call with `timeout: 99999` is clamped to the cap and the result says so
Non-goals: sandboxing the filesystem or network; command blocklists; per-command confirmation changes; scrubbing env for `--no-jail`-style explicit opt-out beyond the documented `--bash-env inherit`
Constraints and dependencies: Windows `cmd.exe` path keeps working (case-insensitive env keys on win32); `ComSpec`, `PATH`, `SystemRoot`, `TEMP` never scrubbed; kill-process-tree behaviour unchanged
Proof method: `packages/agent/test/bash-env.test.ts`, new cases in `packages/agent/test/tools.test.ts`, `packages/cli/test/args.test.ts`; `npm run check`; live run recorded in docs/evidence/bash-env-timeout-acceptance.txt
```

## Global Constraints

- Node `>=22`; no dependency changes.
- Erasable TypeScript only; relative imports with `.ts`.
- `@z-agent/agent` stays filesystem/config-free; policy comes in through options.
- Do not print scrubbed variable names or values anywhere (tool result, details, logs).
- Do not create commits unless the user explicitly asks.

---

## File Map

| File | Responsibility |
| --- | --- |
| Create `packages/agent/src/tools/bash-env.ts` | `BashEnvPolicy`, `DEFAULT_BASH_ENV_POLICY`, `DEFAULT_SECRET_PATTERNS`, `PROTECTED_KEYS`, `buildChildEnv()`. Pure. |
| Create `packages/agent/test/bash-env.test.ts` | Policy matrix: scrub / inherit / allow overrides deny / extra deny / protected keys / win32 case-insensitivity. |
| Modify `packages/agent/src/tools/bash.ts` | `BashToolOptions.env`, `BashToolOptions.timeout`; `resolveTimeoutMs` takes defaults + cap; `runCommand(…, env)`; schema description; clamp notice in result text. |
| Modify `packages/agent/src/tools/options.ts` | Nothing (keep `CodingToolsOptions` free of bash-specific fields); bash-specific options stay in `BashToolOptions`. |
| Modify `packages/agent/src/tools/index.ts` | `createCodingTools(cwd, options & { bash?: BashToolOptions })` pass-through. |
| Modify `packages/agent/test/tools.test.ts` | Env scrub via real spawn (`printenv`/`set` per platform), default timeout, clamp, `inherit`. |
| Modify `packages/agent/src/index.ts` | Export `BashEnvPolicy`, `DEFAULT_BASH_ENV_POLICY`, `buildChildEnv`. |
| Modify `packages/cli/src/args.ts` | `--bash-timeout <seconds>`, `--bash-env scrub|inherit`; help; validation errors. |
| Modify `packages/cli/src/cli.ts` | Pass `bash: { timeout: { defaultSeconds, maxSeconds }, env: policy }` into `createAllTools`; `/status` line shows `bash: timeout 600s/3600s, env scrub`. |
| Modify `packages/cli/src/model-settings.ts` | `formatRuntimeStatus` accepts an optional `bash` summary string. |
| Modify `packages/cli/test/args.test.ts`, `packages/cli/test/model-settings.test.ts` | Flag parse + status line. |
| Modify `packages/cli/src/system-prompt.ts` | One sentence: commands have a default timeout; long jobs must pass `timeout` explicitly or run in the background. |
| Create `docs/adr/0029-bash-env-timeout.md`; modify `docs/adr/README.md`, `docs/roadmap.md`, `docs/glossary.md`, `packages/agent/README.md`, `packages/cli/README.md` | Record decision and terms. |

## Locked Product Decisions

1. **Denylist, not allowlist.** An allowlist breaks `nvm`, `pyenv`, `cargo`, Nix, `direnv`, and proxies. Default policy removes variables whose **name** matches any of `DEFAULT_SECRET_PATTERNS` and passes everything else. Patterns (case-insensitive, anchored on the full key):
   `_API_KEY$`, `_SECRET(_KEY|_ACCESS_KEY)?$`, `_TOKEN$`, `_PASSWORD$`, `_PASSWD$`, `_CREDENTIALS?$`, `_PRIVATE_KEY$`, `^AWS_SESSION_TOKEN$`, `^GH_TOKEN$`, `^GITHUB_TOKEN$`, `^NPM_TOKEN$`, `^OPENAI_API_KEY$`, `^ANTHROPIC_API_KEY$`, `^AZURE_OPENAI_API_KEY$`, `^GOOGLE_API_KEY$`, `^HF_TOKEN$`, `^DATABASE_URL$`.
2. **Protected keys are never scrubbed** regardless of pattern: `PATH`, `HOME`, `USER`, `SHELL`, `LANG`, `LC_*`, `TERM`, `TMPDIR`, `TEMP`, `TMP`, `ComSpec`, `SystemRoot`, `PATHEXT`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `PWD`.
3. **Policy shape:** `{ mode: "scrub" | "inherit"; deny?: RegExp[]; allow?: string[]; set?: Record<string,string> }`. `allow` names win over `deny`. `set` is applied last (used by tests and by `PILLOW_*` markers later). `inherit` = today's behaviour.
4. **Timeout defaults:** `defaultSeconds: 600`, `maxSeconds: 3600`. Model-provided `timeout` above `maxSeconds` is clamped and the tool result is prefixed with `Note: timeout clamped to 3600s.` Model-provided `0` or negative is still an error (unchanged). Result on expiry stays `Timed out after <n> seconds` where `<n>` is the effective value.
5. **Schema text:** `timeout` description becomes `Timeout in seconds (default 600, max 3600). Long jobs: pass an explicit timeout or background the process.` Argument names unchanged so existing sessions replay.
6. **CLI:** `--bash-timeout <seconds>` sets `defaultSeconds` (must be `1..maxSeconds`), `--bash-env inherit` opts out of scrubbing. No env-var equivalents in this slice; no catalog fields.
7. **Extension-provided tools** are untouched; only the built-in bash tool is governed here.
8. **No observability of what was scrubbed** — neither names nor counts leave the tool. (Loop D may log a count under debug; not here.)

## Contract Map

```ts
// packages/agent/src/tools/bash-env.ts
export interface BashEnvPolicy {
	mode: "scrub" | "inherit";
	deny?: readonly RegExp[];
	allow?: readonly string[];
	set?: Readonly<Record<string, string>>;
}
export const DEFAULT_SECRET_PATTERNS: readonly RegExp[];
export const PROTECTED_KEYS: ReadonlySet<string>;
export const DEFAULT_BASH_ENV_POLICY: BashEnvPolicy; // { mode: "scrub" }
export function buildChildEnv(
	source: NodeJS.ProcessEnv,
	policy?: BashEnvPolicy,
	platform?: NodeJS.Platform,
): NodeJS.ProcessEnv;
```

```ts
// packages/agent/src/tools/bash.ts additions
export interface BashTimeoutPolicy {
	defaultSeconds: number; // 600
	maxSeconds: number;     // 3600
}
export const DEFAULT_BASH_TIMEOUT: BashTimeoutPolicy;
export interface BashToolOptions extends CodingToolsOptions {
	kill?: ProcessKiller;
	env?: BashEnvPolicy;
	timeout?: Partial<BashTimeoutPolicy>;
	/** Injected for tests; defaults to process.env. */
	sourceEnv?: NodeJS.ProcessEnv;
}
export function resolveTimeoutMs(requested: number | undefined, policy: BashTimeoutPolicy): { ms: number; clamped: boolean };
```

```ts
// packages/agent/src/tools/index.ts
export interface AllToolsOptions extends CodingToolsOptions { bash?: Omit<BashToolOptions, keyof CodingToolsOptions>; }
export function createCodingTools(cwd: string, options?: AllToolsOptions): AgentTool[];
export function createAllTools(cwd: string, options?: AllToolsOptions): AgentTool[];
```

```ts
// packages/cli/src/args.ts
export interface CliArgs { /* … */ bashTimeout?: number; bashEnv: "scrub" | "inherit"; }
```

---

### Task 1: Env policy module

**Files:** Create `packages/agent/src/tools/bash-env.ts`, `packages/agent/test/bash-env.test.ts`.

- [x] **Step 1: Failing tests** — with source `{ PATH, HOME, OPENAI_API_KEY, MY_SERVICE_TOKEN, GITHUB_TOKEN, DATABASE_URL, NODE_ENV, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY }`: default policy keeps `PATH HOME NODE_ENV AWS_ACCESS_KEY_ID`, drops the rest; `mode: "inherit"` returns an equal copy (not the same object); `allow: ["GITHUB_TOKEN"]` keeps it; `deny: [/^NODE_ENV$/]` drops it; `set` overrides; on `platform: "win32"` a key `openai_api_key` is dropped and `Path` is protected (case-insensitive compare); the returned object never contains `undefined` values.
- [x] **Step 2: Implement** `buildChildEnv` as a single pass over `Object.entries(source)`; comparisons on `key.toUpperCase()` when `platform === "win32"`, exact otherwise; protected check before deny check.
- [x] **Step 3: Run** `npx vitest --run packages/agent/test/bash-env.test.ts`, then `npm run check`.

### Task 2: Timeout policy in the bash tool

**Files:** Modify `packages/agent/src/tools/bash.ts`; add cases in `packages/agent/test/tools.test.ts`.

- [x] **Step 1: Failing tests** — `resolveTimeoutMs(undefined, {600,3600})` → `{ms: 600_000, clamped:false}`; `(99999, …)` → `{ms: 3_600_000, clamped:true}`; `(0, …)` throws; `(30, …)` → 30_000. Integration: `createBashTool(cwd, { timeout: { defaultSeconds: 1, maxSeconds: 2 }, kill })` running `sleep 5` with no `timeout` → result text `Timed out after 1 seconds`, `details.exitCode === null`, injected kill called; running with `timeout: 10` → clamped to 2s and text starts with `Note: timeout clamped to 2s.`
- [x] **Step 2: Implement** — replace the current `resolveTimeoutMs(timeout)` with the policy version; keep the `2_147_483_647` guard inside it; prepend the clamp note to the returned `text` (not to `details`).
- [x] **Step 3: Run** `npx vitest --run packages/agent/test/tools.test.ts`, then `npm run check`.

### Task 3: Env policy in the bash tool

**Files:** Modify `packages/agent/src/tools/bash.ts`, `packages/agent/src/tools/index.ts`, `packages/agent/src/index.ts`; more cases in `tools.test.ts`.

- [x] **Step 1: Failing tests** — `createBashTool(cwd, { sourceEnv: { ...process.env, OPENAI_API_KEY: "sk-test" } })` running `printenv OPENAI_API_KEY` (POSIX) / `echo %OPENAI_API_KEY%` (win32) → output does not contain `sk-test`, exit code is non-zero on POSIX; `printenv PATH` non-empty; with `env: { mode: "inherit" }` the value is present; `createAllTools(cwd, { bash: { sourceEnv } })` propagates the option; exported symbols exist from `@z-agent/agent`.
- [x] **Step 2: Implement** — `const childEnv = buildChildEnv(options.sourceEnv ?? process.env, options.env, process.platform)` computed **per call** (so a `set` in policy and any runtime env changes are honoured); pass as `env: childEnv` to `spawn`.
- [x] **Step 3: Run** focused tests, `npm run check`.

### Task 4: CLI flags and status

**Files:** Modify `packages/cli/src/args.ts`, `packages/cli/src/cli.ts`, `packages/cli/src/model-settings.ts`, `packages/cli/src/system-prompt.ts`; tests `args.test.ts`, `model-settings.test.ts`, `system-prompt.test.ts`.

- [x] **Step 1: Failing tests** — `parseArgs(["--bash-timeout","120"])` → `bashTimeout: 120`; `["--bash-timeout","0"]` → `error` set; `["--bash-timeout","5000"]` → error mentions max 3600; `["--bash-env","inherit"]` → `bashEnv: "inherit"`; `["--bash-env","yolo"]` → error; default `bashEnv === "scrub"`; help includes both flags; `formatRuntimeStatus({ …, bash: "timeout 600s/3600s, env scrub" })` renders the line; system prompt contains the timeout sentence.
- [x] **Step 2: Implement** — `cli.ts` composes `bash: { timeout: { defaultSeconds: args.bashTimeout ?? 600 }, env: args.bashEnv === "inherit" ? { mode: "inherit" } : undefined }` into `createAllTools`.
- [x] **Step 3: Run** focused tests, `npm run check`.

### Task 5: ADR, docs, evidence

- [x] `docs/adr/0029-bash-env-timeout.md` — Alternatives: allowlist (rejected: breaks toolchains), value-pattern scrubbing (rejected: false positives, cost), separate credential store only (rejected: doesn't remove inherited env), no default timeout (rejected: hung turns). Add row to README.
- [x] Roadmap `Phase 3.2 — Bash env scrub and default timeout`; glossary `env scrub`, `timeout clamp`.
- [x] `packages/agent/README.md`, `packages/cli/README.md`: policy table and flags.
- [x] Evidence `docs/evidence/bash-env-timeout-acceptance.txt`: transcript of `OPENAI_API_KEY=sk-live… npx z-agent -p --yes "run: printenv OPENAI_API_KEY; echo exit=$?"` (key redacted in the file), a default-timeout run with `--bash-timeout 2` and `sleep 5`, and an `--bash-env inherit` control run.

## Execution Loop (per task)

1. Red → 2. Green → 3. Focused vitest → 4. `npm run check` → 5. One-line evidence entry → next task.

## Whole-branch review checklist

- `grep -n "process.env" packages/agent/src/tools/bash.ts` — only as the default for `sourceEnv`.
- No scrubbed key names in any string literal that reaches tool output.
- `bashSchema` argument names unchanged; only `.describe()` text changed.
- Windows branch reviewed by reading: `ComSpec` resolution still uses the scrubbed env's `ComSpec` fallback to `cmd.exe`.
- Test count delta, evidence file, ADR row.

## Risks

- Tools like `gh`/`aws` inside the agent stop working because their tokens are scrubbed. This is intended; document `--bash-env inherit` and the `allow` policy field as the escape hatch, and mention it in the timeout/clamp error text? No — keep error text stable; document only.
- Existing sessions whose bash calls relied on no timeout: they now expire at 600s; system prompt sentence mitigates.
