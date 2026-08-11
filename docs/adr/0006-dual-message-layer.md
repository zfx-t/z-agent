# ADR-0006: Dual message layer

## Status

Accepted

## Context

Transcript needs notifications, future compaction markers, and queue-injected user messages. Provider APIs need a strict role/content shape.

## Decision

- **AgentMessage**: transcript / emit / queues / future durable entries
- **Message**: LLM-only, via required injectable `convertToLlm`
- Custom roles may exist on AgentMessage; default conversion drops non-LLM roles

Provider-specific wire types stay inside `@z-agent/ai` adapters.

## Consequences

- Extra conversion step each turn
- Extensibility without polluting provider schemas

## Alternatives

- Single layer Message everywhere
- Three layers (Agent + Canonical + Provider) as public API
