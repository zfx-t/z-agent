# ADR-0016: Coding product surface (TUI-first)

## Status

Accepted

## Context

The in-memory kernel and Responses path can run tools, but a usable product needs a coding shell whose experience is not worse than pi-coding-agent. A readline-only slice is not that bar.

ADR-0010 still holds: loop effects are only `streamAssistant` and `tool.execute`. File/shell tools are `AgentTool` implementations, not loop internals.

## Decision

**Product goal:** full alignment with pi-coding-agent UX, sequenced P1→P6 (TUI + tools first; thinking SSE; sessions; compaction; skills/extensions; L5 harness).

**Package placement:**

- Coding tools live in `@z-agent/agent` (`src/tools/`), exported as `createCodingTools` / `createAllTools`
- Interactive UI lives in `@z-agent/tui` (clean-room, no `@earendil-works/pi-tui`, no ink, no native addon)
- `@z-agent/cli` is the product bin (`z-agent`)
- L5 is a later `@z-agent/harness` package wrapping the same two effect functions

**Stricter than pi (intentional):**

- Path jail (realpath prefix) on by default; `--no-jail` disables
- Built-in confirm UI for `bash` / `write` / `edit` in the TUI (Allow once / Always this session / Deny)
- Print / non-TTY defaults to `--yes` so pipelines work

**P1 in:** seven tools (read+images, write, edit, bash+Win process tree, grep, ls, find), TUI, confirm, print flags (`-p`, `--yes`, `--no-jail`, `--cwd`, `--model`).

**Later phases:** thinking SSE + signature replay; JSONL session tree; compaction; skills/extensions + project trust; L5 `op.state`.

## Consequences

- Agent package grows a tools module; the loop stays generic
- CLI is no longer a smoke bin
- Follow-on ADRs record thinking replay and harness details

## Alternatives

- Tools only in CLI (rejected: product and SDK would duplicate)
- Import pi-tui (rejected: clean-room)
- Skip jail/confirm (rejected: requested product bar)
