# z-agent

Clean-room agent runtime and LLM protocol for a durable-capable control loop.

| Package | Name | Role |
|---------|------|------|
| `packages/ai` | `@z-agent/ai` | Messages, stream events, faux provider, OpenAI **Responses API** stream |
| `packages/agent` | `@z-agent/agent` | Agent loop, tools, queues, Agent shell |
| `packages/cli` | `@z-agent/cli` | Minimal smoke bin (`z-agent`) — faux default, optional `--live` |
| _(later)_ | `@z-agent/harness` | L5 durable: intent / effect / settle + `op.state` |

## Status

Libraries + tiny demo CLI. Loop implementation follows the ordered plan in `AGENTS.md` and `docs/`.

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

## Try the agent (smoke CLI)

```bash
# offline faux stream + echo tool (no API key)
npm run z-agent
npx z-agent "hello"

# live OpenAI Responses
OPENAI_API_KEY=sk-... npm run z-agent -- --live "echo hi"
```

See [`packages/cli/README.md`](packages/cli/README.md).

## Principles (short)

- **Clean-room**: no dependency on pi packages; pi is a semantic oracle.
- **Dual messages**: `AgentMessage` in the transcript; LLM `Message` only at the provider boundary.
- **Effect discipline**: provider stream and `tool.execute` are the only core effects.
- **Not a toy harness**: L5 is the same loop with durable commits, not a second runtime.
