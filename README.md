# z-agent

Clean-room agent runtime, coding TUI, and L5 JSONL harness.

| Package | Name | Role |
|---------|------|------|
| `packages/ai` | `@z-agent/ai` | Messages, stream events, Responses (+ thinking replay) |
| `packages/agent` | `@z-agent/agent` | Loop + coding tools |
| `packages/tui` | `@z-agent/tui` | Alt-screen TUI |
| `packages/cli` | `@z-agent/cli` | `z-agent` bin |
| `packages/harness` | `@z-agent/harness` | L5 intent/effect/settle |

## Try

```bash
export OPENAI_API_KEY=sk-...
npm install --ignore-scripts
npm run z-agent
npx z-agent -p --yes "summarize README.md"
```

See [`packages/cli/README.md`](packages/cli/README.md) and [`docs/adr/`](docs/adr/).
