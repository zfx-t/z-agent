# ADR-0030: L5 op identity, settle phase, and stream replay

## Status

Accepted (amends ADR-0021)

## Context

ADR-0021/0026 shipped the L5 skeleton with two gaps:

- `wrapStreamFn` derived the op id from `sessionId + messages.length`, so two
  different contexts of equal length collided, and collisions are likely after
  `/sessions` restore and compaction.
- The stored stream "result" was the live `AssistantMessageEventStream` object,
  which serialises to junk and cannot be replayed.
- `OpPhase` declared `settle` but `withSandwich` never wrote it, and an op
  interrupted in `effect` phase was silently re-run — unsafe for non-idempotent
  tools like `bash` or `write`.

## Decision

- **Phase semantics:** `intent` (inputs recorded) → `effect` (in flight) →
  `settle` (result durably stored) → `done` (returned to caller). `settle`/`done`
  with a result replays without re-running; `intent` re-runs; `effect` follows
  the resume policy.
- **Op identity:** `tool:<toolCallId>` plus `intentHash = sha256(canonicalJson
  ({name, params}))`; a stored hash mismatch throws `OpIntentMismatchError`.
  Stream ops are `stream:<sessionId|anon>:<sha256(modelId, api, systemPrompt,
  tools, messages)[:32]>`. `StreamOptions` (signal, apiKey, sampling) are never
  persisted. `canonicalJson` sorts keys recursively and replaces long strings /
  byte arrays with digest markers.
- **Resume policy:** `{ interruptedTool, interruptedStream }` × `fail|rerun`,
  defaults `fail` / `rerun`. `"fail"` throws `OpInterruptedError` — the loop
  encodes it as an error toolResult / error AssistantMessage and the op stays
  in `effect` phase, so it can never re-run. `--durable-interrupted-tool`
  selects the tool policy.
- **Stream tee:** `wrapStreamFn` forwards inner events to a fresh outer stream
  but holds the terminal `done`/`error` event until `settle`/`done` commits
  finish — consumers see completion only after the result is durable. Replay
  emits `start` → `done`/`error` → `end` with the stored message, no synthetic
  deltas. `aborted`/`error` results are persisted and replayed as-is so an
  aborted turn is never re-sent.
- **`OpState`** gains `intentHash`, `attempt` (1-based, bumped on each intent
  re-commit), `createdAt`. `OpStore` keeps `load`/`commit`/`delete`. SQLite
  adds columns via `PRAGMA table_info` + guarded `ALTER TABLE`; legacy rows
  without `intent_hash` are accepted.
- `/status` shows `durable: <backend> (interrupted tool: <policy>)`.

## Consequences

- `--durable` resume is actually idempotent for both effect boundaries.
- A crash during `bash` cannot re-execute the command unless the operator
  opts in with `--durable-interrupted-tool rerun`.
- Persisted `error` results replay forever on resume; `store.delete(opId)` is
  the escape hatch.

## Alternatives considered

- Length-based ids with session-scoped counters — rejected: collides after
  session restore and compaction.
- Always re-run interrupted tools — rejected: `bash`/`write` are not
  idempotent.
- Store the full event log for byte-exact replay — rejected: the loop only
  needs the final message; events are derivable.
- Return a stored interruption AgentToolResult instead of throwing — rejected:
  `AgentToolResult` carries no `isError` flag; the loop's thrown-error path is
  the honest encoding.
