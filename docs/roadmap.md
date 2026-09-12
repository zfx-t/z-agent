# Roadmap

## Phase 0 — Scaffold (done)

- Repo, workspaces, docs, ADR/glossary, smoke tests

## Phase 1 — In-memory kernel (1→7) (done)

Agent loop, tools pipeline, shell, queues (ADR-0009).

## Phase 1.5 — In-memory oracle gap-fill (done)

Tools on StreamFn, turn hooks, thinkingLevel (ADR-0015).

## Phase 2 — AI production path (done)

Responses stream; thinking SSE + signature replay (ADR-0017).

## Phase 2.5 — Coding product (done)

- Tools in `@z-agent/agent` (read+images, write, edit, bash+Win tree, grep, ls, find, jail)
- `@z-agent/tui` + confirm UI
- Print (`-p` / `--yes`) and TUI
- JSONL session tree, compaction, initial skills/extensions loading, and project
  trust for executable extensions
- `@z-agent/harness` JSONL L5 (`--durable`)

## Phase 3 — L5 durable harness (done)

JSONL backend (ADR-0021) and SQLite backend via `node:sqlite` behind
`--durable-backend sqlite` (ADR-0026).

## Phase 2.6 — Pillow home + user config (done)

`~/.pillow/config.json` model catalog (aliases, thinking, context). On-disk home renamed from `.z-agent`. (ADR-0022)

## Phase 2.7 - Skills product (done)

- Agent Skills-compatible frontmatter parsing and four-source local discovery
- Confined manifest globs with deterministic project-over-user resolution
- Progressive, full, and index context modes with bounded whole-entry rendering
- Deterministic automatic matching plus explicit slash invocation
- Branch-aware activation/deactivation/mode control nodes
- Constrained `skill_read`, immutable provider snapshots, and TUI slash completion
- Skills available without project trust; executable extensions remain trust-gated

## Phase 2.8 — Model settings inspect and edit (done)

`/status` and `/model` show `contextWindow`, `maxTokens`, and `thinking`. Alias-backed edits persist to `~/.pillow/config.json`. `--context-window` / `--max-tokens` and matching env vars complete ADR-0022 numeric precedence. Bare `/model` opens a picker to switch catalog alias and thinking level mid-session.

## Phase 2.9 — TUI assistant Markdown (done)

Interactive assistant rows render GFM (headings, emphasis, lists, fences, links, tables) through `marked` lexer + first-party painter. Print mode stays raw. (ADR-0023)

## Phase 2.10 — Session checkpoints (R4 first cut) (done)

`/sessions` restores a node through `branch()`; startup always opens a fresh session. Malformed JSONL is refused instead of truncated. Tree chrome beyond picker rows is later. (ADR-0024)

## Phase 2.11 — Command registry and extension surface (done)

Command registry, Extension API v1 (commands / tools / status segments / `on` /
tool renderers), header occupancy, `~/.pillow/keys.json`, and a write-to-editor
command palette. Extension tools stay behind confirm. (ADR-0025)

## Phase 2.12 — Multi-provider dispatch (done)

`openai-completions` and `anthropic-messages` adapters next to the existing
Responses path; `createProviderStream` routes per-call on `model.api`. Catalog
entries and `--api` select the dialect; `ANTHROPIC_*` env keys. (ADR-0027)

## Phase 3.2 — Bash env scrub and default timeout (done)

`buildChildEnv` scrubs secret-shaped variables from the bash child env
(`--bash-env inherit` opts out); `timeout` defaults to 600s, clamps at 3600s
(`--bash-timeout`), and expiry is a normal tool result. `/status` shows the
bash policy. (ADR-0029)
