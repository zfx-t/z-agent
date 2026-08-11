# @z-agent/ai

LLM message protocol and streaming adapters for Z Agent.

## Scope (v0)

- Canonical LLM `Message` / `AssistantMessage` content blocks
- Assistant stream events (`start`, `text_*`, `thinking_*`, `toolcall_*`, `done`, `error`)
- `EventStream` / `AssistantMessageEventStream` (async iterable push stream)
- `StreamFn` contract — failures encoded on the final assistant message, not thrown
- Minimal `Model` typing (`id`, `name`, `api`, `provider`, `baseUrl`, …)
- **Faux provider** (`createFauxStream`) for deterministic unit tests

## Non-goals (v0 this package slice)

- Multi-provider catalog
- Chat Completions dual stack
- OpenAI Responses HTTP adapter (later PR)
- Agent loop (see `@z-agent/agent`)

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
