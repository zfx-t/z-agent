# ADR-0003: Parallel `@z-agent/ai` package

## Status

Accepted

## Context

The agent loop needs a stable LLM message and stream event model. Pure injection without an owned protocol package scatters types across apps.

## Decision

Monorepo contains:

- `@z-agent/ai` — protocol, stream, providers
- `@z-agent/agent` — control loop (depends on ai)
- `@z-agent/harness` — reserved for L5 (not in v0)

Agent still programs against a `StreamFn`-shaped boundary; HTTP lives in `ai`, not inside loop bodies.

## Consequences

- Two packages must version and test in lockstep
- Clear home for Responses adapter and faux provider

## Alternatives

- Agent-only package with injected StreamFn and no ai package
- Full multi-provider platform day one
