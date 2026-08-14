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
- JSONL session tree, compaction, skills, extensions, project trust
- `@z-agent/harness` JSONL L5 (`--durable`)

## Phase 3 — L5 durable harness (done, JSONL)

SQLite backend TBD (separate ADR).
