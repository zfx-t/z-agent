# ADR-0026: SQLite op.state backend

## Status

Accepted

## Context

ADR-0021 shipped the L5 harness with a JSONL/JSON file backend: one file per
`opId` under `op.state/`, overwritten each step. That backend is simple and
inspectable, but every commit is a full file write and the store has no
transactional update.

`withSandwich`, `wrapTools`, and `wrapStreamFn` were typed against the concrete
`JsonlOpStore`, so a second backend needed an interface extraction first.

## Decision

- `OpStore` interface (`load` / `commit` / `delete`) extracted in
  `packages/harness/src/store.ts`. `JsonlOpStore` implements it; sandwich and
  wrap functions accept the interface.
- New `SqliteOpStore` (`packages/harness/src/store-sqlite.ts`) uses
  **`node:sqlite` `DatabaseSync`** — no new npm dependency. One row per op in a
  single `op_state` table inside `op.state.db`, upserted on every commit.
- `node:sqlite` is flagless since Node 22.13.0 (still experimental). The
  `engines` floor for the repo root, `@z-agent/harness`, and `@z-agent/cli`
  moves to `>=22.13.0`. `@z-agent/agent`, `@z-agent/ai`, `@z-agent/tui`, and
  `@z-agent/skills` keep `>=22.0.0` and remain usable on older 22.x.
- CLI gains `--durable-backend jsonl|sqlite` (default `jsonl`); `--durable`
  behavior is unchanged. The DB file lives next to the JSONL store under the
  per-project harness directory.
- `SqliteOpStore` exposes `close()` for tests; the CLI relies on process exit
  rather than a shutdown hook.
- No WAL, busy-timeout, or cross-process concurrency guarantees in this slice.
  `--durable` assumes a single-process session; WAL is a later ADR if needed.

## Consequences

- The once-per-process `ExperimentalWarning` on `node:sqlite` import is accepted
  and visible on stderr in print mode.
- Node older than 22.13 can no longer run the CLI.

## Alternatives

- `better-sqlite3` (rejected: native build/postinstall conflicts with
  `npm install --ignore-scripts`)
- `sql.js` wasm (rejected: added dependency and load overhead for a local
  single-table store)
- Dynamic `import("node:sqlite")` to keep the old engine floor (rejected: no
  dynamic imports in library code; engine bump is clearer)
