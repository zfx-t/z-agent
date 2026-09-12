# @z-agent/cli

Coding agent: TUI (default on TTY) or print (`-p` / non-TTY). Tools come from `@z-agent/agent`.

```bash
export OPENAI_API_KEY=sk-...
npx z-agent
npx z-agent -p --yes "list files and summarize README.md"
```

User state lives in `~/.pillow` (override with `PILLOW_HOME`). Model aliases, thinking, and context window are in `~/.pillow/config.json`. Flag > env > file. A missing file is created once (starter alias `fast` = `gpt-4.1-mini`).

## Flags

`--cwd` `--model` `--api` `--yes` `--no-jail` `-p` `--verbose` `--resume` `--continue` `--session` `--session-dir` `--extension` `--durable` `--durable-backend` `--context-window` `--max-tokens` `--bash-timeout` `--bash-env` `--no-retry` `--debug`

Bash tool policy: the child env is scrubbed of secret-shaped variables
(`*_API_KEY`, `*_TOKEN`, `DATABASE_URL`, …) by default — `--bash-env inherit`
passes the operator env through. Commands default to a 600s timeout and clamp
at 3600s; `--bash-timeout <1-3600>` changes the default. `/status` shows the
active bash policy.

Provider dialect: catalog entry `api` or `--api` selects `openai-responses`
(default), `openai-completions`, or `anthropic-messages`. Keys resolve per api:
`ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL` for anthropic, `OPENAI_*` otherwise.

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
`/sessions` lists saved files then restores a checkpoint (`branch()`); malformed
JSONL is refused. `/status` includes thinking, context window, max tokens, and persist mode. The
TUI always opens a fresh session and notes how many saved sessions exist;
`/sessions` (or `--resume` / `--session <id>`) goes back to an earlier one.
Bare `/model` opens a picker over the catalog aliases and then the thinking
level; the alias switch is session-scoped while a changed thinking level writes
back to the alias in `~/.pillow/config.json`. `/model context|max-tokens|thinking`
edits fields directly.

The TUI keeps its multiline editor available while the agent is working.
`Enter` submits the next instruction, `Shift+Enter` adds a line, and `Ctrl+C`
interrupts without clearing the draft. Tool calls update in place and expose
their input, output, details, duration, and final status in the wide-terminal
inspector.

When the editor's first token starts with `/`, it ranks built-in and skill-name
candidates by exact, prefix, substring, then fuzzy character match. `Tab`
accepts or cycles forward, `Shift+Tab` cycles backward, `Up`/`Down` move the
selection, and `Esc` cancels the
popup without invoking anything.

`Ctrl+P` opens the command palette and inserts the selected token into the
editor. `/commands` still runs the picked command immediately. Optional
`~/.pillow/keys.json` remaps actions (`palette`, `submit`, `newline`, …).
`interrupt` cannot leave `ctrl+c`.

Mouse and keyboard follow Grok-style interaction: the wheel/trackpad scrolls
the transcript with cadence-normalized momentum, and `Z_AGENT_SCROLL_*` env
vars tune it. Clicking a transcript entry selects it (a second click on a tool
toggles its inspector, tabs switch views); clicking the prompt moves the
cursor; clicking a picker row or confirm choice activates it. `PageUp`/
`PageDown` scroll without leaving the prompt, typing while the transcript is
focused forwards the keystroke into the editor, `Shift+←/→` jumps between
turns, and `Ctrl+U`/`Ctrl+D` half-page scroll. `Shift`+arrows/`Home`/`End`
selects draft text and typing replaces the selection. `Esc` drops a selection
or, pressed twice, clears the draft into a stash (`Ctrl+S` restores it) — on
an empty prompt, double-`Esc` opens the session browser.

## Extensions

Trusted project or `--extension` modules may export `createExtension(api)` and
register commands, tools, status segments, tool renderers, and `on(event)`
listeners. Hook-only `createExtension()` modules still load. Extensions cannot
override built-in commands. Extension tools always confirm unless `--yes`.
Load and runtime failures become local warnings.

## Diagnostics and crashes

`--debug` (or `PILLOW_DEBUG=1`) writes a structured JSONL event log to
`~/.pillow/logs/<YYYY-MM-DD>/<sessionId>.jsonl`; `PILLOW_DEBUG=verbose` adds
size fields (`textChars`, `argsChars`) and tool argument key names. `/status`
shows the active `log:` path.

Records: `run.start`, `provider.request`, `provider.retry`,
`provider.response`, `tool.start`, `tool.end`, `loop.turn`, `compaction`,
`crash`, `run.end`. Day directories are `0700` and files `0600`; rotation
keeps 7 days and the newest 50 files per day. Every field is redacted:
secret-shaped keys (`apiKey`, `authorization`, `token`, `password`, …) and
values (`sk-…`, `ghp-…`, `xox…`) become `[redacted]`, and message text or
tool argument values are never written. When diagnostics are off nothing is
created — no directory, no handle.

To attach a log to a bug report: rerun with `--debug`, then send the newest
file under `~/.pillow/logs/`.

On `uncaughtException`, `unhandledRejection`, `SIGTERM`, or `SIGHUP` the
crash guard restores the terminal (alt-screen, bracketed paste, cursor),
persists the session within a 2s deadline, writes a `crash` record, prints
one stderr line, and exits `1`/`143`/`129`. `SIGINT` is unchanged — first
Ctrl-C aborts the run, second exits `130`. Note for extension authors: an
`unhandledRejection` originating in extension code now terminates the
process — keep extension promises awaited or caught.
