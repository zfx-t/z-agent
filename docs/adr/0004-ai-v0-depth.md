# ADR-0004: AI package v0 depth

## Status

Accepted

## Context

A parallel `ai` package can expand into multi-provider catalogs and block the agent loop roadmap.

## Decision

v0 `@z-agent/ai` includes:

- Message + assistant stream event types
- Minimal `Model` typing
- Faux / scripted provider for tests
- **One** production HTTP stream path (see ADR-0005)

v0 excludes multi-provider catalog generation and additional production dialects.

## Consequences

- Agent 1→7 can proceed with deterministic tests
- Hand-running requires a Responses-compatible endpoint

## Alternatives

- Protocol-only (no real HTTP) until agent is done
- Multi-provider skeleton with stubs
