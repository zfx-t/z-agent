# @z-agent/cli

Coding agent: TUI (default on TTY) or print (`-p` / non-TTY). Tools come from `@z-agent/agent`.

```bash
export OPENAI_API_KEY=sk-...
npx z-agent
npx z-agent -p --yes "list files and summarize README.md"
```

User state lives in `~/.pillow` (override with `PILLOW_HOME`). Model aliases, thinking, and context window are in `~/.pillow/config.json`. Flag > env > file. A missing file is created once (starter alias `fast` = `gpt-4.1-mini`).

## Flags

`--cwd` `--model` `--yes` `--no-jail` `-p` `--verbose` `--resume` `--continue` `--session` `--session-dir` `--extension` `--durable`

Print / non-TTY defaults to `--yes`. TUI asks before `bash` / `write` / `edit`. Path jail is on unless `--no-jail`.

Slash: `/exit` `/reset` `/compact` `/sessions` (`/resume`). TUI session picker runs at start when sessions already exist for the cwd.

The TUI keeps its multiline editor available while the agent is working.
`Enter` submits the next instruction, `Shift+Enter` adds a line, and `Ctrl+C`
interrupts without clearing the draft. Tool calls update in place and expose
their input, output, details, duration, and final status in the wide-terminal
inspector.
