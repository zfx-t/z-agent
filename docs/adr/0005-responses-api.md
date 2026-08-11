# ADR-0005: OpenAI Responses API as sole HTTP stream

## Status

Accepted

## Context

One production path must be chosen so stream event mapping is not dual-maintained.

## Decision

The only production HTTP implementation streams the **OpenAI Responses API**.

- No Chat Completions stack in v0
- Adapter normalizes vendor events into Z’s internal assistant stream events
- Faux provider speaks the internal events only

## Consequences

- Narrower proxy/ecosystem compatibility than Chat Completions
- Cleaner item/event model for tools and partials
- Env sketch: `OPENAI_API_KEY`, `OPENAI_BASE_URL` (see `.env.example`)

## Alternatives

- Chat Completions SSE
- Anthropic Messages
- xAI-specific dialect as the protocol layer
