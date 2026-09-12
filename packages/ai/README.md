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

## Retry and timeouts (ADR-0028)

Every adapter shares `ProviderHttpConfig` — set it once on the dispatcher or
per `create*Stream` factory:

```ts
const streamFn = createProviderStream({
	retry: { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 8_000 }, // or false to disable
	timeouts: { headersMs: 60_000, idleMs: 120_000 },               // 0 disables a timer
	onRetry: (e) => console.error(`[retry ${e.attempt}/${e.maxAttempts} in ${e.delayMs}ms: ${e.reason}]`),
});
```

Transient HTTP statuses (408/409/425/429/5xx listed in
`DEFAULT_RETRYABLE_STATUSES`), fetch network errors, and headers timeouts
are retried with jittered backoff; `Retry-After` overrides the delay.
Nothing retries once the stream starts emitting events — partial output is
never duplicated. Caller abort wins at every stage.
