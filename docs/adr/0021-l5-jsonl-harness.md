# ADR-0021: L5 JSONL harness

## Status

Accepted (amended by ADR-0030: content-derived op ids, real `settle` phase,
resume policy, stream replay)

## Context

ADR-0010 reserved `@z-agent/harness` for intent / effect / settle and `op.state`.

## Decision

Ship `@z-agent/harness` with a JSONL/JSON file backend:

- `op.state/{opId}` overwritten each step
- `withSandwich` skips the effect when phase is `done`
- `wrapStreamFn` / `wrapTools` wrap the two ADR-0010 effect boundaries
- CLI `--durable` enables it

SQLite is a later ADR.

## Consequences

Crash recovery is testable without rewriting `runLoop`.

## Alternatives

- Full pi harness port in one slice (rejected: too large)
- SQLite first (rejected: extra dependency)
