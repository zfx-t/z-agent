# Provider Retry and Timeout Implementation Plan (Loop A)

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task closes its own loop: failing test → implementation → focused test → `npm run check` → note in the evidence file.

**Goal:** A transient provider failure (429, 5xx, socket reset before the first SSE event) or a silently hung stream no longer ends the turn with an opaque `error` message. Retries are bounded, honour `Retry-After`, never duplicate partial output, and every timeout surfaces as a distinct, actionable error string.

**Architecture:** Add two pure helpers to `@z-agent/ai` (`retry.ts`, `timeouts.ts`) and thread them through the three adapters via one shared `ProviderHttpConfig`. Retry wraps only the `fetch` call plus the `response.ok` check — the moment `start` is pushed onto the event stream, no retry is possible. Timeouts are implemented with an internal `AbortController` linked to the caller signal; `isAbortError(error, callerSignal)` already distinguishes "user aborted" from "we aborted", so a timeout encodes as `stopReason: "error"`, not `"aborted"`. The StreamFn contract, `AssistantMessageEvent` protocol, and `runLoop` do not change. Effect boundary stays inside `streamAssistant` → adapter → `fetch`.

**Tech Stack:** TypeScript 5.9 (erasable syntax), Node.js 22+, Vitest, Biome. No new dependencies.

## Outcome Contract

```text
User: Coding-agent operator on a flaky or rate-limited endpoint (DeepSeek, OpenRouter, Anthropic burst limits)
Trigger / real entrypoint: any provider call from the TUI or `-p`; opt-out via `--no-retry`
Primary journey: 429 with Retry-After: 2 → one sleep → 200 → normal stream; a stream that stops emitting for idleMs → turn ends with "Stream idle for 120s" instead of hanging until Ctrl-C
Observable success: retries are invisible except for a `[retry 1/3 in 2000ms: HTTP 429]` line under --verbose / debug log; error strings name the cause (HTTP status, headers timeout, idle timeout); abort during a backoff sleep returns `aborted` immediately
Non-goals: retrying after any SSE event was received; resuming a partial stream; provider-specific quota parsing; retry budget across turns; circuit breaker
Constraints and dependencies: StreamOptions and StreamFn signatures unchanged; adapters keep injectable fetch; sleep/clock injectable for tests; no console output from @z-agent/ai (callback only)
Proof method: `packages/ai/test/retry.test.ts`, `packages/ai/test/timeouts.test.ts`, one retry + one idle case per adapter test file, provider-stream config pass-through test; `npm run check`; live acceptance appended to docs/evidence/provider-retry-acceptance.txt
```

## Global Constraints

- Node `>=22`; no dependency changes.
- Erasable TypeScript only; relative imports with `.ts`.
- `@z-agent/ai` never writes to stdout/stderr; retry visibility is via `onRetry` callback only.
- Retry must be impossible once `stream.push({ type: "start" })` has happened in any adapter.
- Caller abort wins over everything: during backoff sleep, during headers wait, during idle wait.
- Do not create commits unless the user explicitly asks.

---

## File Map

| File | Responsibility |
| --- | --- |
| Create `packages/ai/src/retry.ts` | `RetryPolicy`, `DEFAULT_RETRY_POLICY`, `parseRetryAfter`, `computeBackoff`, `fetchWithRetry`. Pure; sleep injected. |
| Create `packages/ai/test/retry.test.ts` | Backoff math, Retry-After parsing (seconds + HTTP-date), status matrix, network-error retry, abort during sleep, attempt cap, callback payloads. |
| Create `packages/ai/src/timeouts.ts` | `StreamTimeouts`, `DEFAULT_STREAM_TIMEOUTS`, `linkAbort`, `withHeadersTimeout`, `withIdleTimeout` (async-iterable wrapper). |
| Create `packages/ai/test/timeouts.test.ts` | Headers timeout fires / clears, idle timer resets per event, timeout reason strings, caller abort propagates, no leaked timers. |
| Modify `packages/ai/src/provider-shared.ts` | `ProviderHttpConfig` (fetch, retry, timeouts, onRetry) and `resolveHttpConfig()`; `httpErrorMessage(prefix, response)` shared by all adapters. |
| Modify `packages/ai/src/openai-responses.ts` | `OpenAIResponsesConfig extends ProviderHttpConfig`; replace bare `fetchFn(...)` + `!response.ok` with `fetchWithRetry`; wrap `parseResponsesSse` with `withIdleTimeout`. |
| Modify `packages/ai/src/openai-completions.ts` | Same wiring. |
| Modify `packages/ai/src/anthropic-messages.ts` | Same wiring. |
| Modify `packages/ai/src/provider-stream.ts` | `ProviderStreamConfig extends ProviderHttpConfig`; pass through unchanged. |
| Modify `packages/ai/src/index.ts` | Export new types and `DEFAULT_*` constants. |
| Modify `packages/ai/test/openai-responses.test.ts`, `openai-completions.test.ts`, `anthropic-messages.test.ts` | Per adapter: 429→200 succeeds with one retry; 500×maxAttempts → error names last status; idle timeout → error string; abort during backoff → `aborted`. |
| Modify `packages/ai/test/provider-stream.test.ts` | Config pass-through: `retry: false` disables; `onRetry` invoked. |
| Modify `packages/cli/src/args.ts` | `--no-retry`; help text. |
| Modify `packages/cli/src/cli.ts` | Build `createProviderStream({ retry, timeouts, onRetry })`; `onRetry` prints under `--verbose` and (Loop D) logs. |
| Modify `packages/cli/test/args.test.ts` | Flag parse. |
| Create `docs/adr/0028-provider-retry-timeout.md`; modify `docs/adr/README.md`, `docs/roadmap.md`, `docs/glossary.md`, `packages/ai/README.md` | Record the decision and the two new terms (`headers timeout`, `idle timeout`). |

## Locked Product Decisions

1. **Retryable conditions:** HTTP `408`, `409`, `425`, `429`, `500`, `502`, `503`, `504`; network errors thrown by `fetch` (`TypeError`, `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `EAI_AGAIN`); headers timeout. Nothing else. `401`/`403`/`400`/`404`/`413`/`422` fail immediately.
2. **Not retryable:** anything after the `start` event; JSON parse errors inside SSE; `stopReason: "error"` reported by the provider inside a 200 stream; caller abort.
3. **Backoff:** `min(maxDelayMs, baseDelayMs * 2^(attempt-1)) * jitter`, jitter uniform in `[0.5, 1.5)`; `Retry-After` (integer seconds or HTTP-date) overrides the computed value but is still capped by `maxDelayMs`. Defaults: `maxAttempts: 3` (= 1 initial + 2 retries), `baseDelayMs: 500`, `maxDelayMs: 8_000`.
4. **Timeouts:** `headersMs: 60_000` (fetch start → response headers), `idleMs: 120_000` (gap between two SSE events, timer starts after headers). Defaults apply to all three adapters. `0` disables that timer.
5. **Error strings (exact prefixes, tests assert on them):**
   - `HTTP 429 Too Many Requests: <detail>` (last attempt's status after retries exhausted; `after N attempts` suffix when N > 1)
   - `Timed out waiting for response headers after 60s`
   - `Stream idle for 120s`
6. **Encoding:** timeout and exhausted-retry both become `stopReason: "error"` with the string above in `errorMessage`; caller abort remains `stopReason: "aborted"` at every phase.
7. **Config precedence:** per-call `options` do not get retry fields (StreamOptions unchanged). Config is per factory: `createProviderStream({ retry, timeouts, onRetry })` and each `create*Stream` accept the same `ProviderHttpConfig`. `retry: false` disables retry entirely.
8. **CLI:** only `--no-retry` in this slice. No `--idle-timeout` flag; operators change timeouts through catalog later if needed. `onRetry` line format under `--verbose`: `[retry <attempt>/<maxAttempts> in <delay>ms: <reason>]`.
9. **Adapter parity:** the three adapters must share `fetchWithRetry` and `withIdleTimeout` — no adapter-local retry logic.

## Contract Map

Later tasks must use these names.

```ts
// packages/ai/src/retry.ts
export interface RetryPolicy {
	maxAttempts: number;
	baseDelayMs: number;
	maxDelayMs: number;
	retryableStatuses: ReadonlySet<number>;
}
export const DEFAULT_RETRY_POLICY: RetryPolicy;

export interface RetryEvent {
	attempt: number;        // 1-based attempt that just failed
	maxAttempts: number;
	delayMs: number;
	reason: string;         // "HTTP 429" | "network: ECONNRESET" | "headers timeout"
}
export type OnRetry = (event: RetryEvent) => void;
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export function parseRetryAfter(header: string | null, now?: number): number | undefined; // ms
export function computeBackoff(attempt: number, policy: RetryPolicy, random?: () => number): number;
export function isRetryableNetworkError(error: unknown): boolean;

export interface FetchWithRetryInput {
	fetch: typeof globalThis.fetch;
	url: string;
	init: RequestInit;
	policy: RetryPolicy | false;
	signal?: AbortSignal;
	headersMs: number;
	onRetry?: OnRetry;
	sleep?: Sleep;
	random?: () => number;
}
/** Resolves with an ok response, or throws the final error (HTTP / network / timeout). */
export function fetchWithRetry(input: FetchWithRetryInput): Promise<Response>;
```

```ts
// packages/ai/src/timeouts.ts
export interface StreamTimeouts {
	headersMs: number;
	idleMs: number;
}
export const DEFAULT_STREAM_TIMEOUTS: StreamTimeouts;

export class StreamTimeoutError extends Error {
	readonly phase: "headers" | "idle";
	readonly ms: number;
}
/** Child controller aborted by the parent or by `abort(reason)`. */
export function linkAbort(parent?: AbortSignal): { signal: AbortSignal; abort: (reason: unknown) => void; dispose: () => void };
export function withHeadersTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number, parent?: AbortSignal): Promise<T>;
export function withIdleTimeout<T>(source: AsyncIterable<T>, ms: number, onTimeout: (error: StreamTimeoutError) => void): AsyncGenerator<T>;
```

```ts
// packages/ai/src/provider-shared.ts additions
export interface ProviderHttpConfig {
	fetch?: typeof globalThis.fetch;
	retry?: Partial<RetryPolicy> | false;
	timeouts?: Partial<StreamTimeouts>;
	onRetry?: OnRetry;
}
export interface ResolvedHttpConfig {
	fetch: typeof globalThis.fetch;
	retry: RetryPolicy | false;
	timeouts: StreamTimeouts;
	onRetry?: OnRetry;
}
export function resolveHttpConfig(config?: ProviderHttpConfig): ResolvedHttpConfig;
export async function httpErrorMessage(prefix: string, response: Response): Promise<string>;
```

```ts
// packages/cli/src/args.ts
export interface CliArgs { /* … */ noRetry: boolean; }
```

---

### Task 1: Retry primitives

**Files:** Create `packages/ai/src/retry.ts`, `packages/ai/test/retry.test.ts`.

- [x] **Step 1: Failing tests** — cases: `parseRetryAfter("2")` → 2000; HTTP-date 3s in future → ~3000; garbage → undefined. `computeBackoff` with `random = () => 0.5` gives `base * 2^(n-1)` capped at `maxDelayMs`. `fetchWithRetry`: 429,429,200 → 200 and two `onRetry` events with attempts 1 and 2; 500×3 → throws `HTTP 500 … after 3 attempts`; 401 → throws immediately, no sleep; `TypeError("fetch failed")` then 200 → ok; abort during sleep → rejects with AbortError and no further fetch; `policy: false` → single attempt.
- [x] **Step 2: Implement** with injected `sleep` that rejects on abort (`signal.addEventListener("abort")`), `random`, and no timers left behind (`clearTimeout` in `finally`).
- [x] **Step 3: Run** `npx vitest --run packages/ai/test/retry.test.ts`.
- [x] **Step 4: `npm run check`** and record test count in evidence.

### Task 2: Timeout primitives

**Files:** Create `packages/ai/src/timeouts.ts`, `packages/ai/test/timeouts.test.ts`.

- [x] **Step 1: Failing tests** — `withHeadersTimeout` rejects with `StreamTimeoutError{phase:"headers"}` when `run` never resolves (use `vi.useFakeTimers`); resolves and clears the timer when `run` resolves first; parent abort rejects with AbortError. `withIdleTimeout`: three events spaced under `ms` pass through; a gap over `ms` calls `onTimeout` once and the generator terminates; `ms = 0` disables. `linkAbort`: parent abort propagates; `dispose` removes the listener.
- [x] **Step 2: Implement.** `withIdleTimeout` races `source.next()` against a per-event timer; on timeout call `onTimeout(err)` and `return`. The adapter's outer catch turns the error into `stopReason: "error"`.
- [x] **Step 3: Run** focused test, then `npm run check`.

### Task 3: Shared HTTP config

**Files:** Modify `packages/ai/src/provider-shared.ts`, `packages/ai/src/index.ts`; add tests to `packages/ai/test/smoke.test.ts` or a new `provider-shared.test.ts`.

- [x] **Step 1: Failing test** — `resolveHttpConfig()` returns defaults; `retry: false` stays `false`; partial `timeouts` merge; `httpErrorMessage` truncates body to 500 chars and tolerates a body read failure.
- [x] **Step 2: Implement** and export `RetryPolicy`, `StreamTimeouts`, `DEFAULT_*`, `RetryEvent`, `OnRetry`, `StreamTimeoutError`, `ProviderHttpConfig`.
- [x] **Step 3: Run** focused tests + `npm run check`.

### Task 4: Wire the Responses adapter

**Files:** Modify `packages/ai/src/openai-responses.ts`, `packages/ai/test/openai-responses.test.ts`.

- [x] **Step 1: Failing tests** (mock fetch, fake timers): 429 with `Retry-After: 1` then 200 SSE → normal `start … done` sequence and exactly one `onRetry`; 503×3 → single `error` event whose `errorMessage` starts with `OpenAI Responses HTTP 503` and contains `after 3 attempts`; body that emits one event then nothing → `Stream idle for` error after `idleMs`; caller abort during backoff → `aborted`; ensure **no `start` event** is emitted for failed attempts.
- [x] **Step 2: Implement** — `const http = resolveHttpConfig(config)`; `const response = await fetchWithRetry({ fetch: http.fetch, url, init, policy: http.retry, signal, headersMs: http.timeouts.headersMs, onRetry: http.onRetry })`; wrap `parseResponsesSse(response.body, linked.signal)` with `withIdleTimeout(..., http.timeouts.idleMs, (e) => { idleError = e; linked.abort(e); })`; in the catch, if `idleError` is set, use its message (do not classify as aborted because the caller signal is not aborted).
- [x] **Step 3: Run** `npx vitest --run packages/ai/test/openai-responses.test.ts`; existing 71 provider tests must still pass.
- [x] **Step 4: `npm run check`.**

### Task 5: Wire Completions and Anthropic adapters

**Files:** Modify `openai-completions.ts`, `anthropic-messages.ts` and their tests.

- [x] **Step 1: Failing tests** — same four cases per adapter as Task 4, with adapter-specific error prefixes (`OpenAI Completions HTTP`, `Anthropic Messages HTTP`).
- [x] **Step 2: Implement** with the identical pattern; no adapter-local branching.
- [x] **Step 3: Run** both test files, then `npm run check`.

### Task 6: Dispatcher pass-through and CLI flag

**Files:** Modify `provider-stream.ts`, `provider-stream.test.ts`, `packages/cli/src/args.ts`, `packages/cli/src/cli.ts`, `packages/cli/test/args.test.ts`.

- [x] **Step 1: Failing tests** — `createProviderStream({ retry: false, fetch })` performs one fetch on 429; `onRetry` reaches the callback through the dispatcher for each api; `parseArgs(["--no-retry"])` sets `noRetry`; help lists the flag.
- [x] **Step 2: Implement** — in `cli.ts` build `createProviderStream({ retry: args.noRetry ? false : undefined, onRetry: (e) => verbose && stderr(`[retry ${e.attempt}/${e.maxAttempts} in ${e.delayMs}ms: ${e.reason}]`) })`.
- [x] **Step 3: Run** focused tests, `npm run check`.

### Task 7: ADR, docs, evidence

- [x] Write `docs/adr/0028-provider-retry-timeout.md` (Context / Decision / Consequences / Alternatives: SDK retry, retry-after-start with dedupe, circuit breaker) and add the row to `docs/adr/README.md`.
- [x] Roadmap: `Phase 3.1 — Provider retry and timeouts`. Glossary: `headers timeout`, `idle timeout`, `retry attempt`.
- [x] `packages/ai/README.md`: config example with `retry` / `timeouts` / `onRetry`.
- [x] Live acceptance → `docs/evidence/provider-retry-acceptance.txt`: (a) `-p --verbose` against a local stub server returning 429 then 200 (script inline in the evidence file); (b) stub that closes the socket after headers → idle error string; (c) `--no-retry` shows a single request.

## Execution Loop (per task)

1. Red: write the test file / cases; run focused vitest; confirm failure message names the missing symbol.
2. Green: implement only the Contract Map surface for that task.
3. Focused run; then `npm run check` (full output, fix all).
4. Append a one-line entry to `docs/evidence/provider-retry-acceptance.txt`: task id, test file, pass count.
5. Only move to the next task when 3 and 4 are clean.

## Whole-branch review checklist (before declaring done)

- `grep -n "start\"" packages/ai/src/*.ts` — every `start` push happens after `fetchWithRetry` resolved.
- No `setTimeout` without a paired `clearTimeout` in `retry.ts` / `timeouts.ts` (fake-timer tests assert `vi.getTimerCount() === 0` at the end).
- `isAbortError(error, signal)` is still the only classifier of `aborted` vs `error`.
- `StreamOptions` diff is empty.
- Test count delta and evidence file present; ADR row added.

## Risks

- Fake-timer interaction with real `ReadableStream` reads in adapter tests: prefer an async-iterable body stub over fake timers where possible; use fake timers only in `retry.test.ts` / `timeouts.test.ts`.
- `fetch` implementations that ignore `signal` on the body: `parseSseJson` already cancels the reader on abort; `linkAbort` reuses that path.
