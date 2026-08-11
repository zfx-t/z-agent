# Z Agent — Design Document (Executable PR Plan)

**Source of truth:** `docs/adr/*`, `docs/glossary.md`, `docs/roadmap.md`, `AGENTS.md`  
**Repo:** `/home/zeroth/ForMe/z-agent`  
**Oracle:** pi `packages/agent` agent-loop / Agent (no `@earendil-works/*` imports)

## Goals

Ship an in-memory agent kernel (Phase 1) plus one production LLM stream path (Phase 2 Responses API), structured so L5 durable harness can wrap the same effect boundaries later.

## Non-goals (this plan)

- Compaction, lanes, session tree, durable storage / `op.state`
- Multi-provider catalog
- Chat Completions dual stack
- Thinking budgets / peripheral Agent options not required for oracle-critical paths

## Architecture (summary)

```
@z-agent/ai          Message, stream events, StreamFn, faux, Responses HTTP
@z-agent/agent       AgentMessage, emit, runLoop, tools, Agent shell, queues
@z-agent/harness     (later) intent / effect / settle + op.state
```

**Effect boundaries (ADR-0010):** only `streamAssistant` (provider) and `tool.execute` (tool body).

**Dual messages (ADR-0006):** AgentMessage in transcript; `convertToLlm` → Message for provider.

**Semantic oracle (ADR-0008):** event order and control flow match pi agent-loop; known forks: zod tools (ADR-0013), Responses API (ADR-0005).

## Implementation notes for all PRs

- TypeScript erasable syntax; relative imports with `.ts` extensions; source exports
- Exact-version pins; `npm install --ignore-scripts`
- After code changes: `npm run check` and run added/changed tests
- Do not import pi packages; may **read** pi source under `/home/zeroth/ForMe/pi` as oracle
- Tests use faux stream; no real network in unit tests
- Default queue modes and toolExecution follow pi (`one-at-a-time`, `parallel`) unless noted

## PR Plan

### PR 1: AI protocol core + faux stream

- **Description:** Implement `@z-agent/ai` foundation: LLM Message / AssistantMessage content blocks, stop reasons, usage skeleton, assistant stream event types, `EventStream` (or equivalent async iterable push stream), `StreamFn` contract, minimal `Model` type, and a **faux** scripted provider for tests. Export from package index. Keep Responses HTTP for PR 8.
- **Files/components affected:** packages/ai/src/**, packages/ai/test/**, packages/ai/README.md
- **Dependencies:** None

### PR 2: Agent types, AgentMessage, emit sink

- **Description:** Add agent-layer types: `AgentMessage` (dual-layer, custom extension surface), `AgentEvent` union aligned with pi event semantics/names where practical, `AgentContext`, tool types using **zod** schemas, `AgentEventSink` / emit helpers, `QueueMode`, `ToolExecutionMode`. Unit-test type-level and simple emit ordering helpers if any. No runLoop yet.
- **Files/components affected:** packages/agent/src/types.ts, packages/agent/src/index.ts, packages/agent/test/**
- **Dependencies:** PR 1

### PR 3: streamAssistant + runLoop (tools-only inner)

- **Description:** Implement `streamAssistant` (partial assistant message lives in context array; emit message_start / message_update / message_end) and `runLoop` double-while with **inner loop driven only by tool calls** (no steering/follow-up yet). Outer loop structure present but follow-up drain empty. Wire `agent_start` / `turn_start` / `turn_end` / `agent_end`. Inject `convertToLlm` and optional `transformContext`. Tests with faux stream for text-only multi-turn stop.
- **Files/components affected:** packages/agent/src/agent-loop.ts, packages/agent/src/stream-assistant.ts (or equivalent), packages/agent/test/**
- **Dependencies:** PR 2

### PR 4: Sequential tools (prepare → execute → after)

- **Description:** Sequential tool execution: validate (zod) + beforeToolCall → tool.execute → afterToolCall → toolResult messages and tool_execution_* events. Honor block, terminate batch semantics, and `stopReason === "length"` fails entire tool batch without execute. Tests cover success, invalid args, blocked before, after overrides, length truncation batch failure, terminate-all early stop.
- **Files/components affected:** packages/agent/src/** (tools execution), packages/agent/test/**
- **Dependencies:** PR 3

### PR 5: Parallel three-phase tool execution

- **Description:** When toolExecution is parallel (default): (1) prepare all sequentially, (2) execute allowed concurrently, (3) tool_execution_end in completion order, toolResult message artifacts in assistant source order. Sequential mode and per-tool sequential override remain. Tests for ordering invariants with delayed tools.
- **Files/components affected:** packages/agent/src/**, packages/agent/test/**
- **Dependencies:** PR 4

### PR 6: Agent shell (mutex, subscribe, abort, continue)

- **Description:** Public `Agent` class: state accessors, `subscribe`/`unsubscribe`, `prompt` / `continue` mutual exclusion while streaming, AbortSignal wiring, `abort()`, state updates from events (streamingMessage, pendingToolCalls, etc.). Includes injectable streamFn, convertToLlm default filter, before/after hooks plumbing into loop config. Tests for mutex throw, abort mid-stream, subscribe receives events.
- **Files/components affected:** packages/agent/src/agent.ts, packages/agent/src/index.ts, packages/agent/test/**
- **Dependencies:** PR 5

### PR 7: Steering and follow-up queues

- **Description:** `steer` / `followUp` queues with `steeringMode` / `followUpMode` (`all` | `one-at-a-time`). Drain points match pi: steering after turn (post tools), follow-up only when agent would stop. Enable full double-while outer loop. Tests for injection order and mode behavior.
- **Files/components affected:** packages/agent/src/agent.ts, packages/agent/src/agent-loop.ts, packages/agent/test/**
- **Dependencies:** PR 6

### PR 8: OpenAI Responses API stream adapter

- **Description:** Production HTTP stream in `@z-agent/ai` for OpenAI Responses API; normalize to internal assistant events. Config via baseUrl/apiKey (env sketch already in `.env.example`). Unit tests with mocked fetch; no live network required. Export factory e.g. `createOpenAIResponsesStream`.
- **Files/components affected:** packages/ai/src/**, packages/ai/test/**, packages/ai/README.md
- **Dependencies:** PR 1

## Success criteria

- `npm run check` and `npm test` green on the assembled stack tip
- Faux-driven agent tests cover: text turn, sequential tools, parallel tools, steer, followUp, abort, length-batch tool failure, terminate batch
- No `@earendil-works/*` in package.json or imports
- Effect boundaries documented in code comments near streamAssistant and tool.execute
