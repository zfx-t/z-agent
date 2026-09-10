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

## Phase 3 — L5 durable harness (done, JSONL)

SQLite backend TBD (separate ADR).

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

`/status` and `/model` show `contextWindow`, `maxTokens`, and `thinking`. Alias-backed edits persist to `~/.pillow/config.json`. `--context-window` / `--max-tokens` and matching env vars complete ADR-0022 numeric precedence.

## Phase 2.9 — TUI assistant Markdown (done)

Interactive assistant rows render GFM (headings, emphasis, lists, fences, links, tables) through `marked` lexer + first-party painter. Print mode stays raw. (ADR-0023)

## Phase 2.10 — Session checkpoints (R4 first cut)

`/sessions` and the startup picker restore a node through `branch()`. Malformed JSONL is refused instead of truncated. Tree chrome beyond picker rows is later. (ADR-0024)
