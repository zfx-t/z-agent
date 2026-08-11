# @z-agent/ai

LLM message protocol and streaming adapters for Z Agent.

## Scope (v0)

- Canonical LLM `Message` / assistant stream event types
- `StreamFn` contract (failures encoded in stream, not thrown)
- Faux provider for tests
- One production path: **OpenAI Responses API** streaming

## Non-goals (v0)

- Multi-provider catalog
- Chat Completions dual stack
- Agent loop (see `@z-agent/agent`)
