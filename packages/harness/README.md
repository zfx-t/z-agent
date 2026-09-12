# @z-agent/harness

L5 durable layer (ADR-0010, ADR-0021, ADR-0026, ADR-0030). Wraps `StreamFn`
and `tool.execute`; does not rewrite the loop.

## Phases

| Phase | Meaning | On resume |
| --- | --- | --- |
| `intent` | op identified, inputs + `intentHash` recorded | re-run (`attempt` +1) |
| `effect` | effect in flight | resume policy: `fail` → `OpInterruptedError`; `rerun` → execute again |
| `settle` | result durably stored, not yet returned | replay stored result |
| `done` | result returned to caller | replay stored result |

## Identity

- Tools: `tool:<toolCallId>` + `intentHash` over `{name, params}` (mismatch →
  `OpIntentMismatchError`).
- Streams: `stream:<sessionId|anon>:<contextHash>` over
  `{modelId, api, systemPrompt, tools, messages}`. `StreamOptions` never
  persist. The final `AssistantMessage` is the stored result; replay emits
  `start → done/error → end` with no synthetic deltas. The terminal event is
  forwarded to consumers only after `settle`/`done` commits land.

## Backends

`JsonlOpStore` (per-op JSON files under `op.state/`) and `SqliteOpStore`
(`node:sqlite`, `op.state.db`, in-place `ALTER TABLE` migration). Both run the
same `describe.each` conformance suite. `OpStore` = `load` / `commit` /
`delete`.

## CLI

`--durable` enables; `--durable-backend jsonl|sqlite`;
`--durable-interrupted-tool fail|rerun` (default `fail`).
