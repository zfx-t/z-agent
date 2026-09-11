# @z-agent/ai

LLM message protocol and streaming adapters for Z Agent.

## Scope (v0)

- Canonical LLM `Message` / assistant stream event types
- `StreamFn` contract (failures encoded in stream, not thrown)
- Production paths, dispatched per call on `model.api` via `createProviderStream` (ADR-0027):
  - `openai-responses` — OpenAI Responses API; reasoning + thinking SSE signature replay (ADR-0017)
  - `openai-completions` — legacy Chat Completions; covers compat endpoints via `baseUrl`
  - `anthropic-messages` — Claude Messages API; thinking `signature` replay, `x-api-key` auth

## Non-goals

- Per-provider code beyond the three api dialects (compat endpoints use `openai-completions` + `baseUrl`)
- Built-in offline mock provider (tests inject their own `StreamFn` / `fetch`)
- Agent loop (see `@z-agent/agent`)

## Quick start

```ts
import { createAnthropicMessagesModel, createProviderStream } from "@z-agent/ai";

const streamFn = createProviderStream();
const model = createAnthropicMessagesModel({ id: "claude-sonnet-4-5" });
// apiKey via StreamOptions or ANTHROPIC_API_KEY / OPENAI_API_KEY env.
```
