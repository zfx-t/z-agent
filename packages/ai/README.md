# @z-agent/ai

LLM message protocol and streaming adapters for Z Agent.

## Scope (v0)

- Canonical LLM `Message` / assistant stream event types
- `StreamFn` contract (failures encoded in stream, not thrown)
- Production path: **OpenAI Responses API** streaming
- Optional request `reasoning.effort` from `StreamOptions.reasoning` (no thinking SSE parse yet)

## Non-goals

- Multi-provider catalog
- Chat Completions dual stack
- Built-in offline mock provider (tests inject their own `StreamFn`)
- Agent loop (see `@z-agent/agent`)

## Quick start (Responses)

```ts
import { createOpenAIResponsesModel, createOpenAIResponsesStream } from "@z-agent/ai";

const streamFn = createOpenAIResponsesStream({
  apiKey: process.env.OPENAI_API_KEY,
  baseUrl: process.env.OPENAI_BASE_URL,
});
const model = createOpenAIResponsesModel({ id: "gpt-4.1-mini" });
```
