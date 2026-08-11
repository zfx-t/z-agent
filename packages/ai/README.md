# @z-agent/ai

LLM message protocol and streaming adapters for Z Agent.

## Scope (v0)

- Canonical LLM `Message` / `AssistantMessage` content blocks
- Assistant stream events (`start`, `text_*`, `thinking_*`, `toolcall_*`, `done`, `error`)
- `EventStream` / `AssistantMessageEventStream` (async iterable push stream)
- `StreamFn` contract — failures encoded on the final assistant message, not thrown
- Minimal `Model` typing (`id`, `name`, `api`, `provider`, `baseUrl`, …)
- **Faux provider** (`createFauxStream`) for deterministic unit tests
- **OpenAI Responses API** production stream (`createOpenAIResponsesStream` / `streamOpenAIResponses`) — ADR-0005

## Non-goals (v0 this package slice)

- Multi-provider catalog
- Chat Completions dual stack
- Agent loop (see `@z-agent/agent`)

## Env sketch

Optional (no dotenv required in the library):

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Default API key when not passed in options/config |
| `OPENAI_BASE_URL` | Default base URL (default `https://api.openai.com/v1`) |

## Quick start (faux)

```ts
import {
  createFauxStream,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@z-agent/ai";

const faux = createFauxStream({
  responses: [
    fauxAssistantMessage([
      fauxToolCall("echo", { text: "hi" }, { id: "c1" }),
      fauxText("done"),
    ], { stopReason: "toolUse" }),
  ],
});

const stream = await faux.streamFn(faux.model, { messages: [] });
for await (const event of stream) {
  // partial updates…
}
const final = await stream.result();
```

## Quick start (OpenAI Responses)

```ts
import {
  createOpenAIResponsesModel,
  createOpenAIResponsesStream,
} from "@z-agent/ai";

const streamFn = createOpenAIResponsesStream({
  // optional; else OPENAI_API_KEY / options.apiKey
  apiKey: process.env.OPENAI_API_KEY,
  baseUrl: process.env.OPENAI_BASE_URL, // optional
});

const model = createOpenAIResponsesModel({ id: "gpt-4.1" });
const stream = streamFn(model, {
  systemPrompt: "Be concise.",
  messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
  tools: [/* optional Tool[] */],
}, { signal: AbortSignal.timeout(60_000) });

for await (const event of stream) {
  // start | text_* | toolcall_* | done | error
}
const message = await stream.result();
```

Also available: `streamOpenAIResponses(model, context, options?, config?)`.

Minimal subset: **text** + **function tool calls**. Unit tests mock `fetch` (no live network).

## StreamFn contract

```ts
type StreamFn = (
  model: Model,
  context: Context,
  options?: StreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
```

Once invoked, request/model/runtime failures must be encoded as an `AssistantMessage`
with `stopReason: "error" | "aborted"` (via an `error` stream event). Do not throw for
business failures.
