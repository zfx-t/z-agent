# z-agent

Clean-room agent runtime and LLM protocol for a durable-capable control loop.

| Package | Name | Role |
|---------|------|------|
| `packages/ai` | `@z-agent/ai` | Messages, stream events, OpenAI **Responses API** stream |
| `packages/agent` | `@z-agent/agent` | Agent loop, tools, queues, Agent shell |
| `packages/cli` | `@z-agent/cli` | Minimal smoke bin (`z-agent`) — Responses + echo tool |
| _(later)_ | `@z-agent/harness` | L5 durable: intent / effect / settle + `op.state` |

## Status

Libraries + tiny demo CLI. Loop implementation follows the ordered plan in `AGENTS.md` and `docs/`.

## Design docs

- [Glossary](docs/glossary.md)
- [ADRs](docs/adr/)

## Requirements

- Node.js >= 22.6
- npm workspaces

```bash
npm install --ignore-scripts
npm run check
npm test
```

## Try the agent (smoke CLI)

```bash
export OPENAI_API_KEY=sk-...
# optional: export OPENAI_BASE_URL=https://api.openai.com/v1

npm run z-agent
npx z-agent "use the echo tool"
```

See [`packages/cli/README.md`](packages/cli/README.md).

## Principles (short)

- **Clean-room**: no dependency on pi packages; pi is a semantic oracle.
- **Dual messages**: `AgentMessage` in the transcript; LLM `Message` only at the provider boundary.
- **Effect discipline**: provider stream and `tool.execute` are the only core effects.
- **Not a toy harness**: L5 is the same loop with durable commits, not a second runtime.
