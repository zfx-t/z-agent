# ADR-0025: Command registry and extension surface

## Status

Accepted

## Context

Interactive commands were a static list plus string matches in `runInteractive`
and `parseSlashInput`. Extensions could only supply `beforeToolCall` /
`afterToolCall`. R5 in `docs/tui-future-direction.md` needs a discoverable
command path, status segments, key bindings, and rendering hooks without new
effect boundaries in `@z-agent/agent`.

## Decision

- Every interactive command is an `InteractiveCommand` on a `CommandRegistry`.
  Built-ins register first. `parseSlashInput` looks up name or alias, then
  `validate`, then `run`.
- Extensions may call `createExtension(api)` and register commands, tools,
  status segments, tool renderers, and read-only `on(event)` listeners. The
  previous hook-only export remains valid.
- Extensions cannot override a built-in name or alias. A later extension cannot
  reuse another extension token. Failed loads, thrown commands, thrown
  renderers, and thrown status segments degrade locally.
- Extension tools always pass the confirmation gate (unless `--yes`).
- `~/.pillow/keys.json` maps actions to chords. `interrupt` stays `ctrl+c`.
- The command palette writes the selected token into the editor. `/commands`
  still executes the picked built-in.

`@z-agent/agent` is unchanged. The TUI still does not import providers, execute
tools, or write durable state.

## Consequences

- CLI owns registry, extension host, keymap load, and status composition.
- SQLite harness and session-tree chrome stay out of this slice.

## Alternatives

- Keep string switches per command (rejected: every new command forks three files)
- Let extensions declare `readOnly` to skip confirm (rejected: self-service bypass)
