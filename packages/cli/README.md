# @z-agent/cli

Coding agent: TUI (default on TTY) or print (`-p` / non-TTY). Tools come from `@z-agent/agent`.

```bash
export OPENAI_API_KEY=sk-...
npx z-agent
npx z-agent -p --yes "list files and summarize README.md"
```

User state lives in `~/.pillow` (override with `PILLOW_HOME`). Model aliases, thinking, and context window are in `~/.pillow/config.json`. Flag > env > file. A missing file is created once (starter alias `fast` = `gpt-4.1-mini`).

## Flags

`--cwd` `--model` `--yes` `--no-jail` `-p` `--verbose` `--resume` `--continue` `--session` `--session-dir` `--extension` `--durable` `--context-window` `--max-tokens`

Print / non-TTY defaults to `--yes`. TUI asks before `bash` / `write` / `edit`. Path jail is on unless `--no-jail`.

## Skills

Skills use Agent Skills-compatible YAML frontmatter in `SKILL.md`; `name` and
`description` are required. The four local sources, in conflict-resolution
order, are:

1. `{cwd}/.pillow/skills.json`
2. `{cwd}/.pillow/skills`
3. `$PILLOW_HOME/skills.json`
4. `$PILLOW_HOME/skills`

Manifest entries may name a skill directory, an exact `SKILL.md`, or a glob.
They cannot be absolute, escape with `..`, or resolve through a symlink outside
the manifest directory. Project skills override same-named user skills, with a
diagnostic retained for the collision.

The default `progressive` mode renders metadata and loads bodies on demand.
`full` injects complete active bodies when they fit the request budget; `index`
renders metadata only. Bodies and XML entries are included whole or omitted,
never silently truncated.

```text
/skills [query]
/skills mode progressive|full|index
/skill <name> [args]
/skill -<name>
/skill all
/<skill-name> [args]
/reload
```

An explicit invocation activates the exact skill and includes its full body for
that request. Arguments apply only to that invocation. `/skill all` activates
eligible, model-invocable skills up to the session cap; hidden skills still
require an exact explicit command. Built-ins take precedence over direct skill
names, and an unknown slash line remains ordinary user text.

Automatic matching is deterministic and based on skill name, description,
keywords, and explicit path hints against `metadata.file-globs`. It activates at
most two new skills per turn and eight per session. `/skill -<name>` records a
manual-off state so automatic matching does not immediately reactivate it.

Activation, deactivation, and mode changes are branch-aware session control
nodes, not provider messages. Resume restores and reconciles the branch state;
compaction leaves it intact. `/reset` clears it and returns to `progressive`.
During streaming, slash commands wait in FIFO order for the next safe turn
boundary. The active provider request keeps its immutable skills snapshot.

`skill_read` is a read-only tool for an indexed skill's `SKILL.md` and supported
text or image resources below that skill directory. It rejects absolute paths,
`..` traversal, directories, unindexed names, and symlink escapes. It does not
widen the ordinary `read` tool's cwd jail.

Skills are untrusted supplemental instructions and can be discovered and
activated without project trust. Executable extensions remain trust-gated.
`allowed-tools` is display-only advisory metadata; it never grants a tool,
bypasses confirmation, or changes the path jail.

## Interactive Commands

Built-ins include `/exit`, `/new`, `/reset`, `/clear`, `/compact`, `/sessions`
(`/resume`), `/status`, `/model`, `/commands`, `/skills`, `/skill`, and `/reload`.
`/status` includes thinking, context window, max tokens, and persist mode. The
TUI session picker runs at start when sessions already exist for the cwd.

The TUI keeps its multiline editor available while the agent is working.
`Enter` submits the next instruction, `Shift+Enter` adds a line, and `Ctrl+C`
interrupts without clearing the draft. Tool calls update in place and expose
their input, output, details, duration, and final status in the wide-terminal
inspector.

When the editor's first token starts with `/`, it ranks built-in and skill-name
candidates by exact, prefix, substring, then fuzzy character match. `Tab`
accepts or cycles forward, `Shift+Tab` cycles backward, and `Esc` cancels the
popup without invoking anything.
