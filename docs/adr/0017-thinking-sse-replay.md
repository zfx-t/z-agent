# ADR-0017: Responses thinking SSE and signature replay

## Status

Accepted

## Context

ADR-0015 shipped `reasoning.effort` on the request only. Reasoning models require replaying reasoning items (including `encrypted_content`) on later turns.

## Decision

When `StreamOptions.reasoning` is set:

- Request `include: ["reasoning.encrypted_content"]`
- Parse reasoning SSE into `ThinkingContent` (`thinking_start` / `delta` / `end`)
- Store `thinkingSignature = JSON.stringify(reasoning item)`
- `convertResponsesMessages` pushes parsed reasoning items back into `input`

## Consequences

Multi-turn tool use on reasoning models no longer drops required reasoning items.

## Alternatives

- Keep omitting thinking (rejected: breaks GPT-5-class models)
