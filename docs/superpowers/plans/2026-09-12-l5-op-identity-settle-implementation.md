# L5 Op Identity, Settle Phase, and Stream Replay Implementation Plan (Loop C)

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task closes its own loop: failing test → implementation → focused test → `npm run check` → note in the evidence file.

**Goal:** Make `--durable` actually idempotent for both effect boundaries. Today (`packages/harness/src/wrap.ts`) the stream opId is `stream:<sessionId>:<messages.length>` — two different contexts of equal length collide — and the stored stream "result" is the live `AssistantMessageEventStream` object, which serialises to junk and replays as a non-stream. `OpPhase` declares `settle` but `withSandwich` never writes it. After this loop: op identity is content-derived, the four phases have defined meaning, a stream replays as a real event stream from the persisted final `AssistantMessage`, and an op interrupted mid-effect is handled by an explicit policy instead of being silently re-run.

**Architecture:** All changes stay inside `@z-agent/harness` plus a small `cli.ts` wiring touch. `withSandwich` grows an `intentHash` check and a `resume` policy; `wrapStreamFn` tees the inner stream into a fresh `createAssistantMessageEventStream()` and commits `settle` with the final message on `end`. `OpStore` keeps its three methods (`load`/`commit`/`delete`); `OpState` gains `intentHash`, `attempt`, `createdAt`. Both JSONL and SQLite backends run the same conformance suite. The agent loop topology is untouched (ADR-0010 / ADR-0021).

**Tech Stack:** TypeScript 5.9 (erasable syntax), Node.js 22+, `node:crypto` (sha256), `node:sqlite`, Vitest, Biome. No new dependencies.

## Outcome Contract

```text
User: Operator running `z-agent --durable [--durable-backend sqlite]` who kills the process mid-turn and restarts with `--resume`
Trigger / real entrypoint: `wrapStreamFn` / `wrapTools` decorators installed by cli.ts when `args.durable`
Primary journey: (1) crash after the provider answered but before the loop appended the message → resume replays the same AssistantMessage without a network call; (2) crash while `bash` was executing → resume returns a tool error "interrupted before completion; not re-run" instead of running the command twice; (3) two different prompts of equal message count in one session → two distinct ops
Observable success: replayed stream emits start → done/error → end with the persisted message; op files/rows show phase progression intent → effect → settle → done with attempt counters; `harness.test.ts` conformance passes on both backends
Non-goals: op garbage collection; cross-session dedupe; partial-stream resumption; making tools declare idempotency; durable steering/follow-up queues; changing the `OpStore` method count
Constraints and dependencies: `OpStore` interface unchanged (3 methods); `runLoop` untouched; JSON-serialisable results only; sha256 from node:crypto; existing evidence for ADR-0021/0026 stays valid
Proof method: harness conformance tests on JsonlOpStore + SqliteOpStore, wrap tests with a scripted StreamFn, `npm run check`, manual crash/resume transcript in docs/evidence/l5-resume-acceptance.txt
```

## Global Constraints

- Node `>=22`; no dependency changes.
- Erasable TypeScript only; relative imports with `.ts`.
- Effect boundaries: `wrapStreamFn`/`wrapTools` remain decorators around the two effect functions; nothing else in the harness performs I/O except the stores.
- Never persist `apiKey` or `StreamOptions` — the stream intent stores only `{ model, api, messageCount, contextHash }`.
- Do not create commits unless the user explicitly asks.

---

## File Map

| File | Responsibility |
| --- | --- |
| Create `packages/harness/src/op-id.ts` | `canonicalJson`, `sha256Hex`, `streamOpId`, `toolOpId`, `intentHash`. Pure. |
| Create `packages/harness/test/op-id.test.ts` | Key-order independence, collision cases, id shape. |
| Modify `packages/harness/src/store.ts` | `OpState` gains `intentHash`, `attempt`, `createdAt`; `OpPhase` doc comments define each phase; `JsonlOpStore` unchanged in behaviour. |
| Modify `packages/harness/src/store-sqlite.ts` | Columns `intent_hash TEXT`, `attempt INTEGER`, `created_at INTEGER`; `ALTER TABLE … ADD COLUMN` guarded migration for existing dbs. |
| Modify `packages/harness/src/sandwich.ts` | Four-phase writes; `intentHash` mismatch error; `resume` policy for `effect`-phase ops; `attempt` increments. |
| Modify `packages/harness/src/wrap.ts` | `wrapStreamFn` tee + settle-on-end + replay builder; `wrapTools` passes the resume policy; both accept `WrapOptions`. |
| Create `packages/harness/src/replay.ts` | `replayAssistantMessage(message): AssistantMessageEventStream`. |
| Modify `packages/harness/src/index.ts` | Export new symbols. |
| Modify `packages/harness/test/harness.test.ts` | Becomes the conformance suite parameterised over both stores; adds phase progression, mismatch, resume policy, stream tee/replay, equal-length distinct contexts. |
| Modify `packages/harness/test/store-sqlite.test.ts` | Migration from the old 6-column schema; new columns round-trip. |
| Modify `packages/cli/src/cli.ts` | Pass `{ resume: { interruptedTool: "fail", interruptedStream: "rerun" } }`; `/status` shows `durable: jsonl|sqlite`. |
| Modify `packages/cli/src/args.ts` | `--durable-interrupted-tool fail|rerun` (default `fail`). |
| Modify `packages/cli/test/args.test.ts` | Flag parse. |
| Create `docs/adr/0030-l5-op-identity-settle.md`; modify `docs/adr/0021-l5-jsonl-harness.md` (status → Amended by 0030), `docs/adr/README.md`, `docs/roadmap.md`, `docs/glossary.md`, `packages/harness/README.md` | Record the decision; define phases in the glossary. |

## Locked Product Decisions

1. **Phase semantics (final):**
   - `intent` — op identified and inputs recorded; effect not started.
   - `effect` — effect in flight (provider request open / tool body running).
   - `settle` — effect finished and its **result is durably stored**; the caller has not yet been handed the result.
   - `done` — `withSandwich` returned the result to the caller.
   Replay rule on `load`: `settle` or `done` with `result !== undefined` → return the stored result, no effect. `intent` → run normally (bump `attempt`). `effect` → apply the resume policy.
2. **Resume policy:** `{ interruptedTool: "fail" | "rerun"; interruptedStream: "rerun" | "fail" }`. Defaults `interruptedTool: "fail"`, `interruptedStream: "rerun"`. `"fail"` for a tool returns `AgentToolResult { text: 'Tool "<name>" was interrupted before completion and was not re-run (durable resume policy). Re-issue the command if needed.', isError: true }` and commits `settle`/`done` with that result so the loop proceeds deterministically. `"fail"` for a stream produces an error-encoded AssistantMessage the same way.
3. **Op identity:**
   - Tool: `tool:<toolCallId>` (unchanged) **plus** `intentHash = sha256(canonicalJson({ name, params }))`. A hit with a different `intentHash` throws `OpIntentMismatchError` — a toolCallId reused with different arguments is a caller bug, not something to paper over.
   - Stream: `stream:<sessionId|anon>:<sha256(canonicalJson({ modelId, api, messages }))[0:32]>`; intent `{ model, api, messageCount, contextHash }`. `context.systemPrompt` and `context.tools` (names + parameter schema JSON) are included in the hash; `StreamOptions` are not (they contain `signal`/`apiKey`).
   - `canonicalJson`: recursive key sort, no whitespace, `undefined` dropped, arrays in order. `Uint8Array`/image payloads hashed by base64 length + sha256 of bytes to keep the canonical string bounded.
4. **Stream tee:** `wrapStreamFn` returns a *new* `AssistantMessageEventStream`; every event from the inner stream is forwarded unchanged; on inner `end(final)` commit `settle { result: final }`, then `done`, then `outer.end(final)`. If the inner stream ends in `error`/`aborted`, the result **is still persisted** with that `stopReason` — an aborted turn must not be re-sent to the provider on resume; `"aborted"` results are replayed as-is (the loop already ends the turn on `aborted`).
5. **Replay shape:** `start { partial: message }` → `done { reason, message }` or `error { reason, error: message }` → `end(message)`. No synthetic deltas. Thinking blocks and signatures are replayed verbatim because they live on the persisted message.
6. **Attempt counter:** `attempt` starts at 1 on first `intent` and increments each time `withSandwich` writes `intent` again for an existing opId (i.e. after an `intent`-phase crash or a `rerun`). `createdAt` set once; `updatedAt` per commit (existing behaviour).
7. **SQLite migration:** on open, `PRAGMA table_info(op_state)`; add missing columns with `ALTER TABLE`. Rows without `intent_hash` are treated as matching (legacy), logged nowhere.
8. **Out of scope:** GC / retention of op files, per-tool idempotency flags, durable queues, opId exposure in the TUI.

## Contract Map

```ts
// packages/harness/src/op-id.ts
export function canonicalJson(value: unknown): string;
export function sha256Hex(input: string | Uint8Array): string;
export function intentHash(intent: unknown): string;
export function streamOpId(input: { sessionId?: string; modelId: string; api: string; context: Context }): { opId: string; contextHash: string };
export function toolOpId(toolCallId: string): string;
```

```ts
// packages/harness/src/store.ts
export type OpPhase = "intent" | "effect" | "settle" | "done";
export interface OpState<TIntent = unknown, TResult = unknown> {
	opId: string;
	kind: OpKind;
	phase: OpPhase;
	intent?: TIntent;
	intentHash?: string;
	result?: TResult;
	attempt: number;
	createdAt: number;
	updatedAt: number;
}
// OpStore unchanged: load / commit / delete
```

```ts
// packages/harness/src/sandwich.ts
export interface ResumePolicy {
	interruptedTool: "fail" | "rerun";
	interruptedStream: "rerun" | "fail";
}
export const DEFAULT_RESUME_POLICY: ResumePolicy;
export class OpIntentMismatchError extends Error { readonly opId: string; readonly expected: string; readonly actual: string; }
export interface SandwichInput<TIntent, TResult> {
	store: OpStore;
	opId: string;
	kind: OpKind;
	intent: TIntent;
	effect: () => Promise<TResult>;
	/** Called instead of `effect` when a previous attempt was interrupted in `effect` phase and the policy says "fail". */
	onInterrupted: () => TResult;
	policy: "fail" | "rerun";
}
export function withSandwich<TIntent, TResult>(input: SandwichInput<TIntent, TResult>): Promise<TResult>;
```

```ts
// packages/harness/src/replay.ts
export function replayAssistantMessage(message: AssistantMessage): AssistantMessageEventStream;
// packages/harness/src/wrap.ts
export interface WrapOptions { resume?: Partial<ResumePolicy>; }
export function wrapTools(tools: AgentTool[], store: OpStore, options?: WrapOptions): AgentTool[];
export function wrapStreamFn(streamFn: StreamFn, store: OpStore, options?: WrapOptions): StreamFn;
```

```ts
// packages/cli/src/args.ts
export interface CliArgs { /* … */ durableInterruptedTool: "fail" | "rerun"; }
```

---

### Task 1: Op identity

**Files:** Create `packages/harness/src/op-id.ts`, `packages/harness/test/op-id.test.ts`.

- [ ] **Step 1: Failing tests** — `canonicalJson({b:1,a:{d:2,c:3}}) === '{"a":{"c":3,"d":2},"b":1}'`; `undefined` fields dropped; arrays keep order; `streamOpId` differs for two contexts with equal message counts but different text; equal for the same context built with different key order; changes when `systemPrompt` changes; changes when a tool's schema changes; `toolOpId("call_1") === "tool:call_1"`; ids match `/^stream:[^:]+:[0-9a-f]{32}$/`.
- [ ] **Step 2: Implement** with `node:crypto` `createHash("sha256")`.
- [ ] **Step 3: Run** focused test, `npm run check`.

### Task 2: Store shape and SQLite migration

**Files:** Modify `store.ts`, `store-sqlite.ts`; tests `store-sqlite.test.ts`, `harness.test.ts`.

- [ ] **Step 1: Failing tests** — round-trip an `OpState` with `intentHash`, `attempt: 2`, `createdAt` through both stores; open a SQLite file created with the **old** 6-column DDL (test writes it directly with `node:sqlite`) then `load` an old row → `attempt === 1`, `intentHash === undefined`, and `commit` on it succeeds.
- [ ] **Step 2: Implement** the column additions and the guarded migration; JSONL store needs only the type change (`attempt ?? 1` default on load).
- [ ] **Step 3: Run** focused tests, `npm run check`.

### Task 3: Four-phase sandwich with mismatch and resume policy

**Files:** Modify `sandwich.ts`; tests in `harness.test.ts` (parameterised `describe.each([["jsonl", …], ["sqlite", …]])`).

- [ ] **Step 1: Failing tests** — phase progression observed through a recording store wrapper: `["intent","effect","settle","done"]`; `settle`-phase op with result replays without calling `effect`; `intent`-phase op re-runs with `attempt` 2; `effect`-phase op + policy `"fail"` calls `onInterrupted`, never `effect`, and ends `done`; `effect`-phase + `"rerun"` runs `effect` with `attempt` 2; `intentHash` mismatch throws `OpIntentMismatchError` before any commit; legacy row without `intentHash` is accepted.
- [ ] **Step 2: Implement** — compute `hash = intentHash(intent)`; load; branch per phase; write `intent` (with `attempt`, `createdAt` preserved), `effect`, run, `settle { result }`, `done`.
- [ ] **Step 3: Run** `npx vitest --run packages/harness/test/harness.test.ts`, then `npm run check`.

### Task 4: Stream tee and replay

**Files:** Create `replay.ts`; modify `wrap.ts`, `index.ts`; tests in `harness.test.ts`.

- [ ] **Step 1: Failing tests** — with a scripted inner StreamFn that emits `start, text_delta×2, done, end`: the outer stream yields the identical event sequence; after it ends the store holds `settle`→`done` with `result.content` equal to the final message; calling the wrapped StreamFn again with the same context performs **zero** inner calls and yields `start, done, end` whose `message` deep-equals the stored one; an inner stream that ends `aborted` is persisted and replayed as `aborted`; two contexts of equal length map to two op rows; `interruptedStream: "fail"` on an `effect`-phase row yields an error-encoded message without an inner call; `wrapTools` with `"fail"` returns the interruption `AgentToolResult` (`isError: true`) and with `"rerun"` executes again.
- [ ] **Step 2: Implement** — `wrapStreamFn`: build `{ opId, contextHash }`, call `withSandwich` whose `effect` returns a Promise that resolves with the **final AssistantMessage** after teeing (so the sandwich stores a message, not a stream), and return the outer stream synchronously. Concretely: create outer stream; kick off `withSandwich(...)` in a `void (async () => …)()`; on replay path, pipe `replayAssistantMessage(result)` into outer. Errors thrown by `withSandwich` (e.g. mismatch) become an error-encoded message on the outer stream, never a throw out of the StreamFn (StreamFn contract).
- [ ] **Step 3: Run** focused tests, `npm run check`.

### Task 5: CLI wiring

**Files:** Modify `packages/cli/src/args.ts`, `cli.ts`, `model-settings.ts`; tests `args.test.ts`, `model-settings.test.ts`.

- [ ] **Step 1: Failing tests** — `--durable-interrupted-tool rerun` parses; invalid value errors; default `fail`; status line includes `durable: sqlite (interrupted tool: fail)` when durable.
- [ ] **Step 2: Implement** — pass `{ resume: { interruptedTool: args.durableInterruptedTool } }` to both wrappers.
- [ ] **Step 3: Run** focused tests, `npm run check`.

### Task 6: ADR, docs, evidence

- [ ] `docs/adr/0030-l5-op-identity-settle.md` — Alternatives: keep length-based ids with session-scoped counters (rejected: collides after `/sessions` restore and compaction), always re-run interrupted tools (rejected: bash/write are not idempotent), store the whole event log for byte-exact replay (rejected: loop only needs the final message; events are derivable). Mark ADR-0021 "Amended by 0030".
- [ ] Roadmap `Phase 3.3 — L5 op identity and settle`; glossary entries for the four phases, `intent hash`, `resume policy`.
- [ ] `packages/harness/README.md` phase table and replay shape.
- [ ] Evidence `docs/evidence/l5-resume-acceptance.txt`: (1) `--durable` run, `kill -9` during a bash `sleep 30`, `--resume` → interruption result, op row shows `attempt 1`, phase `done`; (2) kill after `settle` of a stream (inject a delay via a test extension or run with a stub server) → resume replays with no request in the stub log; (3) same steps with `--durable-backend sqlite`; (4) `sqlite3`-free proof: `node -e` script prints `PRAGMA table_info(op_state)` showing new columns on a pre-existing db.

## Execution Loop (per task)

1. Red → 2. Green → 3. Focused vitest → 4. `npm run check` → 5. One-line evidence entry → next task.

## Whole-branch review checklist

- `grep -n "messages.length" packages/harness/src` returns nothing outside intent metadata.
- `wrapStreamFn` never returns a Promise-wrapped stream from `withSandwich` — the outer stream is created synchronously; the sandwich result type is `AssistantMessage`.
- No `StreamOptions` field is persisted (`grep -n "apiKey\|signal" packages/harness/src` empty).
- Every `OpStore` implementation still has exactly `load`, `commit`, `delete`.
- Both backends run the identical `describe.each` suite; SQLite migration test uses the old DDL verbatim from git history of `store-sqlite.ts`.
- Docs: interview stub in `docs/interview/` that says "settle unused / opId by length" must be updated to reflect the new state (it is a claims document, keep it truthful).

## Risks

- Canonical hashing cost for large contexts (images): bounded by hashing bytes instead of base64 strings; measured in a test with a 5 MB image block (< 50 ms).
- Replaying an `error` result forever on resume: acceptable and intended — the operator sees the same error; `delete(opId)` is available and `--durable-interrupted-tool rerun` covers the tool side. Document in README.
