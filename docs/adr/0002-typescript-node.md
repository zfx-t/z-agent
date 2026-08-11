# ADR-0002: TypeScript on Node

## Status

Accepted

## Context

The oracle and authoring environment are TypeScript. The agent core is an async state machine, not a compute kernel.

## Decision

- Language: TypeScript
- Runtime: Node.js `>=22`
- First class: Node only (no Bun/Deno API guarantees in v0)
- `erasableSyntaxOnly` / erasable TypeScript syntax

## Consequences

- Fast iteration against pi mental model
- Multi-runtime support deferred

## Alternatives

- Rust core + TS bindings
- Dual Node + Bun from day one
