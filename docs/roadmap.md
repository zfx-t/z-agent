# Roadmap

## Phase 0 — Scaffold (done)

- Repo, workspaces, docs, ADR/glossary, smoke tests

## Phase 1 — In-memory kernel (1→7) (done)

1. AgentMessage + emit(event)
2. runLoop double-while (inner: tools only)
3. streamAssistant: partial in array + start/update/end
4. tool: prepare → execute → after → toolResult
5. sequential tools; parallel three-phase
6. shell: prompt mutex, subscribe, abort signal
7. steering + follow-up queues

Plus ADR-0009 extras: continue, transformContext, convertToLlm, before/after, terminate, length-batch failure.

## Phase 1.5 — In-memory oracle gap-fill (done)

- AgentTool (zod) → LLM Tool (JSON Schema) on `streamAssistant` Context
- `prepareNextTurn` / `shouldStopAfterTurn` after `turn_end` (ADR-0015)
- `thinkingLevel` on AgentState; `StreamOptions.reasoning`; Responses `reasoning.effort`
- `addedToolNames` passthrough; `agentLoop` / `agentLoopContinue` EventStream wrappers

## Phase 2 — AI production path (done)

- Responses API stream adapter wired for hand-runs and CLI
- Unit tests inject scripted `StreamFn` helpers (not a public mock provider)

## Phase 3 — L5 durable harness

- Package `@z-agent/harness`
- intent commit / effect / settle commit per ADR-0010
- `op.state` total program counter
- Storage backend TBD (separate ADRs)
