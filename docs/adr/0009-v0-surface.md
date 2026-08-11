# ADR-0009: v0 practical core surface

## Status

Accepted

## Context

Full pi Agent surface would delay the 1→7 build order.

## Decision

**In v0:**

- Steps 1–7 (messages/emit, double while, streamAssistant, tools, serial+parallel, shell, queues)
- `continue()`, `transformContext`, injectable `convertToLlm`
- `beforeToolCall` / `afterToolCall`
- `terminate` batch semantics
- `stopReason === "length"` → fail entire tool batch without executing

**Out of v0:**

- Compaction, branch summarization, lanes, session tree
- Durable L5 / harness
- Thinking budgets and other peripheral Agent options unless required for oracle-critical paths

Defaults for `steeringMode`, `followUpMode`, and `toolExecution` follow pi unless a later ADR changes them.

## Consequences

- Shippable in-memory kernel with real hooks
- L5 projects only tested steps

## Alternatives

- Narrower core without before/after/terminate
- Near-full in-memory pi parity before L5
