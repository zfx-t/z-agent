# z-agent

Clean-room agent runtime, coding TUI, and L5 JSONL harness.

| Package | Name | Role |
|---------|------|------|
| `packages/ai` | `@z-agent/ai` | Messages, stream events, Responses / Completions / Anthropic adapters |
| `packages/agent` | `@z-agent/agent` | Loop + coding tools |
| `packages/skills` | `@z-agent/skills` | Skill discovery, matching, state, rendering, and resource validation |
| `packages/tui` | `@z-agent/tui` | Alt-screen TUI |
| `packages/cli` | `@z-agent/cli` | `z-agent` bin |
| `packages/harness` | `@z-agent/harness` | L5 intent/effect/settle |

## Try

```bash
export OPENAI_API_KEY=sk-...        # openai-responses / openai-completions
export ANTHROPIC_API_KEY=sk-ant-... # anthropic-messages
npm install --ignore-scripts
npm run z-agent
npx z-agent -p --yes "summarize README.md"
```

Config: `~/.pillow/config.json` (ADR-0022). Model catalog entries pick the wire
dialect with `api`: `openai-responses` (default), `openai-completions`, or
`anthropic-messages`; `--api` overrides per run (ADR-0027).

## Skills

Z Agent discovers Agent Skills-compatible `SKILL.md` files from the user and
project `.pillow` directories and their `skills.json` manifests. The default
`progressive` mode indexes metadata, activates deterministic matches, and loads
bodies only when explicitly invoked or read through the constrained
`skill_read` tool.

```text
/skills
/code-review focus on authorization
/skill -code-review
/skills mode full
/reload
```

Project skills override user skills. Skills are untrusted supplemental context
and load without project trust; executable extensions remain trust-gated.
`allowed-tools` metadata is advisory and cannot change tool authorization,
confirmation, or path-jail behavior.

See [`packages/skills/README.md`](packages/skills/README.md),
[`packages/cli/README.md`](packages/cli/README.md), and
[`docs/adr/`](docs/adr/).
