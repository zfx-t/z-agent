# ADR-0010: Effect boundaries for L5

## Status

Accepted

## Context

L5 durable harness is the same control flow with intent commit / effect / settle commit and `op.state`. If v0 blurs side effects, L5 requires a rewrite.

## Decision

In `@z-agent/agent` v0:

| Kind | Function | Notes |
|------|----------|--------|
| Provider effect | `streamAssistant` consuming `StreamFn` | Only network/model I/O |
| Tool effect | `tool.execute` | Only tool body side effects |
| Non-effects | validate, before/after, emit, array ops, queue drain | No fetch/exec hidden here |

- No `op.state`, no storage, no in-memory durable interpreter in v0
- L5 (`@z-agent/harness`) wraps the same functions in sandwiches

## Consequences

- Slightly stricter code structure now
- L5 is packaging, not a second loop topology

## Alternatives

- Free-form v0, refactor at L5
- Full intent/settle state machine in memory from day one
