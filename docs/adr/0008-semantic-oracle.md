# ADR-0008: pi semantic oracle

## Status

Accepted

## Context

Clean-room (ADR-0001) leaves open how closely behavior tracks pi.

## Decision

Treat pi’s in-memory `agent-loop` and `Agent` as a **semantic oracle**:

- Align control flow **and** event ordering/semantics
- Reimplement with independent fixtures; do not import pi
- Any intentional divergence requires an ADR

Known planned divergences: ADR-0005 (Responses), ADR-0013 (zod).

## Consequences

- Higher test discipline; track pi behavior changes consciously
- Easier mental debugging against pi source

## Alternatives

- Inspiration only (no order guarantees)
- Hybrid: control flow only, free event names
