# @z-agent/cli

Minimal smoke CLI that wires `@z-agent/agent` + `@z-agent/ai`. Demo only — not a product shell.

## Run

From monorepo root (after `npm install --ignore-scripts`):

```bash
# offline faux (default — no API key)
npx z-agent
npx z-agent "use the echo tool"

# or via package script
npm run z-agent -- "hello"

# live OpenAI Responses (requires key)
OPENAI_API_KEY=sk-... npx z-agent --live "echo hi"
```

Bin entry: `z-agent` → `packages/cli/bin/z-agent.mjs` (Node ≥22, strip-types for source exports).

## Behavior

| Mode | When | Stream |
|------|------|--------|
| faux | default | scripted tool call (`echo`) + final text |
| live | `--live` + `OPENAI_API_KEY` | `createOpenAIResponsesStream` |

Prints lifecycle lines: `agent_start`, tool start/end, assistant text, `agent_end`.
