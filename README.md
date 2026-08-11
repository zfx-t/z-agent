# z-agent

Clean-room agent runtime and LLM protocol for a durable-capable control loop.

| Package | Name | Role |
|---------|------|------|
| `packages/ai` | `@z-agent/ai` | Messages, stream events, faux provider, OpenAI **Responses API** stream |
| `packages/agent` | `@z-agent/agent` | Agent loop, tools, queues, Agent shell |
| _(later)_ | `@z-agent/harness` | L5 durable: intent / effect / settle + `op.state` |

## Status

Scaffold only. Loop implementation follows the ordered plan in `AGENTS.md` and `docs/`.

## Design docs

- [Glossary](docs/glossary.md)
- [ADRs](docs/adr/)

## Requirements

- Node.js >= 22
- npm workspaces

```bash
npm install --ignore-scripts
npm run check
npm test
```

## Principles (short)

- **Clean-room**: no dependency on pi packages; pi is a semantic oracle.
- **Dual messages**: `AgentMessage` in the transcript; LLM `Message` only at the provider boundary.
- **Effect discipline**: provider stream and `tool.execute` are the only core effects.
- **Not a toy harness**: L5 is the same loop with durable commits, not a second runtime.
