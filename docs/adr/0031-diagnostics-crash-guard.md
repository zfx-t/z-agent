# ADR-0031: Diagnostics log and crash guard

## Status

Accepted

## Context

When an operator says "it hung" or "it crashed and my terminal is garbage",
there was nothing to look at: `packages/cli` had no logger, and the only crash
handler was `main().catch`. An `unhandledRejection`/`uncaughtException` inside
the TUI left alt-screen, bracketed paste, and the hidden cursor on, and lost
the unsaved session tail.

## Decision

Two injected-dependency modules in `@z-agent/cli`; `@z-agent/agent`,
`@z-agent/ai`, `@z-agent/tui` gain no logging code (ADR-0010 boundaries —
`agent.subscribe` is a non-effect read of the event stream).

- `diagnostics.ts` — structured JSONL sink. Enabled by `--debug` or
  `PILLOW_DEBUG=1|verbose` (flag wins). Disabled is a true no-op: no
  directory, no handle, `log()` returns synchronously. Records
  `{ ts, seq, kind, sessionId, ...fields }` append to
  `~/.pillow/logs/<YYYY-MM-DD>/<sessionId>.jsonl`; day dirs `0700`, files
  `0600`. Kinds: `run.start`, `provider.request`, `provider.retry` (Loop A
  `onRetry`), `provider.response`, `tool.start`, `tool.end`, `loop.turn`,
  `compaction`, `crash`, `run.end`. `provider.*`/`tool.*`/`loop.turn` derive
  from `agent.subscribe` events; durations come from per-turn/per-toolCall
  timestamps. Appends serialise on a promise queue; a write failure warns to
  stderr once and is swallowed afterwards — the agent loop is never blocked
  by its own log.
- `redact()` runs over every record's fields, verbose included. Keys matching
  `api[-_]?key|authorization|x-api-key|token|secret|password` (matched on
  segment boundaries so `estTokens`/`totalTokens` survive) and values
  matching `sk|sk-ant|ghp|gho|xox[abp]-…` become `"[redacted]"`. Message text
  and tool argument values are never serialised; `verbose` adds only
  `textChars`/`argsChars` sizes and argument key names.
- Rotation at sink creation: day dirs older than 7 days are removed and the
  current day keeps the newest 50 `*.jsonl` by name. Only `YYYY-MM-DD` dirs
  and `*.jsonl` files under the logs root are ever touched.
- `crash-guard.ts` — `install(process)` wires `uncaughtException`,
  `unhandledRejection`, `SIGTERM`, `SIGHUP` to one ordered shutdown:
  latch → `restoreTerminal()` (`TuiSession.close()`; no-op in print) →
  `persistSession()` raced against a 2 s deadline → crash record + `flush()`
  bounded to 500 ms → one stderr line (`z-agent crashed: <message>
  (log: <path>)`, or `(rerun with --debug for a log)` when disabled) →
  `exit(1|143|129)`. A second fault in flight skips to stderr+exit.
  `SIGINT` stays owned by `SigintAbort` — second Ctrl-C still exits 130.
- `main().catch` routes through the guard as `source: "main"`. Normal exits
  log `run.end { exitCode, turns, durationMs }` and await `flush()` before
  `process.exit`; the guard is uninstalled after the run so late rejections
  from test doubles or extensions do not re-trigger it.
- `/status` shows `log: <path>` when diagnostics are on. `--verbose` print
  output is unchanged; `PILLOW_DEBUG` is read in `cli.ts`, not `args.ts`.
- `compaction.ts` gains a pure `onCompaction(info)` callback option; the CLI
  maps it onto a `compaction` record.

## Consequences

- A hang or crash report can be answered with "attach
  `~/.pillow/logs/<day>/<session>.jsonl`" instead of a description of stderr.
- `unhandledRejection` from an extension now terminates the process — a
  deliberate production choice; documented in the extension notes.
- The terminal is restored before anything else on the crash path; persist
  can lose its deadline race, in which case `sessionPersisted: false` is on
  the crash record.
- Diagnostics ordering is only as precise as the event stream: a queued user
  message injected after a no-tool turn is logged as `followUpDrained` even
  when it technically arrived via the steering poll.

## Alternatives

- `debug` npm package (rejected: dependency, unstructured output, no redaction)
- Logging inside `@z-agent/agent` / `@z-agent/ai` (rejected: ADR-0010 effect
  boundaries; `subscribe` and `onRetry` already expose everything)
- OpenTelemetry (rejected for v0: weight; record shape stays OTel-mappable)
- `process.on("exit")` only (rejected: cannot await `persistSession`)
