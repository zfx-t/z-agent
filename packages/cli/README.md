# @z-agent/cli

Coding agent: TUI (default on TTY) or print (`-p` / non-TTY). Tools come from `@z-agent/agent`.

```bash
export OPENAI_API_KEY=sk-...
npx z-agent
npx z-agent -p --yes "list files and summarize README.md"
```

## Flags

`--cwd` `--model` `--yes` `--no-jail` `-p` `--verbose` `--resume` `--continue` `--session` `--session-dir` `--extension` `--durable`

Print / non-TTY defaults to `--yes`. TUI asks before `bash` / `write` / `edit`. Path jail is on unless `--no-jail`.

Slash: `/exit` `/reset` `/compact` `/sessions` (`/resume`). TUI session picker runs at start when sessions already exist for the cwd.
