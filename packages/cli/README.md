# @z-agent/cli

Minimal smoke bin wiring `@z-agent/agent` + `@z-agent/ai` (OpenAI Responses).

## Run

```bash
# from monorepo root
export OPENAI_API_KEY=sk-...
# optional: export OPENAI_BASE_URL=https://api.openai.com/v1

npm run z-agent
npx z-agent "use the echo tool"
```

## Env

| Variable | Required | Notes |
|----------|----------|--------|
| `OPENAI_API_KEY` | yes | Responses API key |
| `OPENAI_BASE_URL` | no | API base URL |

## Notes

- One demo tool: `echo` (zod + real execute)
- No offline mock path — always hits the Responses stream
