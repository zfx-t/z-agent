# ADR-0027: Multi-provider stream dispatch

## Status

Accepted

## Context

ADR-0005 chose OpenAI Responses as the sole production HTTP path. Real use
needs the legacy OpenAI Chat Completions dialect (third-party compat endpoints:
DeepSeek, Together, Groq, OpenRouter, …) and the Anthropic Messages dialect
(Claude). `Model.api` already exists as the dispatch discriminator; the StreamFn
contract and AssistantMessageEvent protocol need no changes.

## Decision

- Three adapters in `@z-agent/ai`, each exporting
  `stream*` / `create*Stream` / `create*Model` / `convert*` / `build*Body`:
  - `openai-responses.ts` (existing)
  - `openai-completions.ts` — `POST {base}/chat/completions`, `stream_options.
    include_usage`, tool_calls aggregated per `index`, `reasoning_effort`,
    `reasoning_content` deltas → thinking blocks (no signature, not replayed)
  - `anthropic-messages.ts` — `POST {base}/v1/messages`, `x-api-key` +
    `anthropic-version` headers, `anthropic-beta` only when thinking is enabled,
    `max_tokens` required (options.maxTokens ?? model.maxTokens ?? 4096)
- `createProviderStream()` returns a StreamFn that reads `model.api` **per
  call** and routes to the adapter; unknown api → error-encoded message, never
  a throw. Mid-session `/model` switches therefore need no re-wiring.
- Shared internals: `sse.ts` (`parseSseJson`) and `provider-shared.ts`
  (pending output, abort/error helpers, tool-arg parsing, id normalization).
- Catalog: `config.json` model entries gain optional
  `api: "openai-responses" | "openai-completions" | "anthropic-messages"`;
  absent means `openai-responses`. `--api` flag overrides the entry.
- Env dispatch by api: `anthropic-messages` → `ANTHROPIC_API_KEY` /
  `ANTHROPIC_BASE_URL`; others → `OPENAI_API_KEY` / `OPENAI_BASE_URL`.
  `entry.apiKey` / `entry.baseUrl` still apply beneath env.
- Replay: anthropic thinking blocks replay `signature` verbatim
  (`thinkingSignature`), `redacted` → `redacted_thinking`; completions does not
  replay thinking at all. Consecutive toolResult messages merge into one
  anthropic `user` turn of `tool_result` blocks.
- Thinking budgets (anthropic): minimal=1024, low=2048, medium=8192,
  high=16384, xhigh/max=32768, clamped to `< max_tokens`; dropped when the
  clamp would go below 1024.
- `/status` and `/model` display the resolved `api` (read-only).

## Consequences

- Any completions-compatible endpoint works via `api:"openai-completions"` +
  `baseUrl`; no per-provider code.
- Switching api mid-session drops thinking history on the completions path
  (no signature to replay) — acceptable, documented.

## Alternatives

- `openai` npm SDK / `@anthropic-ai/sdk` (rejected: new deps for minimal wire
  subsets; fetch+SSE already proven by the responses adapter)
- Per-provider catalog entries / provider plugins (rejected: `model.api` +
  `baseUrl` covers the same ground with less machinery)
- `max_completion_tokens` for completions (rejected for this slice: compat
  endpoints standardize on `max_tokens`; revisit if OpenAI drops it)
