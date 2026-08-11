# ADR-0001: Clean-room relative to pi

## Status

Accepted

## Context

We need an agent runtime that can grow into a durable harness (L5). pi’s agent-loop and harness are the best existing reference, but depending on `@earendil-works/*` couples our durable model and public types to an upstream we do not control.

## Decision

Implement Z Agent as a **clean-room** codebase:

- No runtime or type dependency on `@earendil-works/*`
- pi source and docs are a **semantic oracle** only
- Own `AgentMessage`, events, and stream contracts

## Consequences

- Full ownership of L5 `op.state` and commit shapes
- Must re-encode behavior in our tests (no import of pi)
- Deliberate divergences require a new ADR

## Alternatives

- Depend on `pi-ai` only
- Fork `packages/agent`
