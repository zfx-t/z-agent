# ADR-0015: Post-v0 in-memory oracle surface

## Status

Accepted

## Context

v0 (ADR-0009) shipped the 1→7 kernel plus Responses (ADR-0005). pi’s in-memory `agent-loop` / `Agent` still have oracle-critical pieces that v0 deferred or never wired:

- `streamAssistant` does not put tools on `Context` (zod tools are not typebox `Tool`)
- `prepareNextTurn` / `shouldStopAfterTurn` after `turn_end`
- `thinkingLevel` on `AgentState` (mapped to `StreamOptions.reasoning`)
- `addedToolNames` on tool results
- low-level `agentLoop` / `agentLoopContinue` EventStream wrappers

Jumping to L5 (ADR-0010) with these gaps would bake the production tool-path bug into the durable layer.

## Decision

**In this slice (in-memory oracle gap-fill):**

- Convert `AgentTool` (zod) → LLM `Tool` (JSON Schema) and pass tools from `streamAssistant`
- `prepareNextTurn` after `turn_end` (may replace context / model / thinkingLevel for later turns in the same run)
- `shouldStopAfterTurn` after prepare, before steering; `true` → `agent_end` and skip steering/follow-up
- `thinkingLevel` on `AgentState` (default `"off"` → omit `reasoning`); not `thinkingBudgets`
- `addedToolNames` field passthrough on `AgentToolResult` / `ToolResultMessage` (no deferred-tool loading)
- `agentLoop` / `agentLoopContinue` return `EventStream`; `runAgentLoop*` stay. Wrapper `catch`es `runAgentLoop` rejection so `result()` does not hang (small fork vs pi’s uncaught `.then`)
- Responses request body may set `reasoning.effort` from `StreamOptions.reasoning`; no thinking SSE parse / signature replay

**Still out:**

- `@z-agent/harness` / `op.state` / durable storage
- Compaction, lanes, session tree, proxy
- `thinkingBudgets`, `setDefaultStreamFn`
- Deferred-tools / `additional_tools` protocol

Hook order matches pi: `turn_end` → `prepareNextTurn` → `shouldStopAfterTurn` → `getSteeringMessages`. Snapshots from `prepareNextTurn` affect later `streamAssistant` calls in this run only; `Agent.processEvents` does not write them back to `state.thinkingLevel`.

## Consequences

- Real Responses calls can advertise function tools
- Turn hooks exist before L5 wraps the same loop
- Thinking *events* from the provider remain a later adapter task

## Alternatives

- Start L5 immediately (rejected: seals the missing `Context.tools` path)
- Full Responses thinking SSE + signature replay in this slice (rejected: large adapter, not required for kernel oracle)
