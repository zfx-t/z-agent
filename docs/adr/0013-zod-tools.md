# ADR-0013: zod for tool schemas

## Status

Accepted

## Context

Tool `prepare` must validate arguments. pi uses typebox; clean-room allows a different choice.

## Decision

Use **zod** as the tool parameters schema library in `@z-agent/agent`.

- Oracle alignment is on control flow and events, not schema DSL
- Invalid args → no `execute` → error toolResult + matching emits

## Consequences

- Explicit divergence from pi tool definition style
- Pin exact `zod` version in the agent package

## Alternatives

- typebox (closer to pi)
- Minimal hand-rolled JSON Schema subset
- Validation fully external to the agent
