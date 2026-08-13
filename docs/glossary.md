# Glossary

Authoritative terms for Z Agent. ADR ids in parentheses where a decision owns the term.

## AgentMessage

Application-level transcript message. May include roles and fields that never go to the provider. Owns what `emit`, queues, and (later) durable entries refer to. (ADR-0006)

## Message (LLM Message)

Provider-boundary message produced by `convertToLlm(AgentMessage[])`. Only user / assistant / toolResult shapes that the model API accepts. (ADR-0006)

## StreamFn

Injected (or ai-package-provided) function: `(model, context, options?) => AssistantMessageEventStream`. Must not throw for business failures; encode error/abort on the final assistant message. (ADR-0003, ADR-0004)

## emit / AgentEvent

Async sink the loop uses to publish lifecycle events (`agent_start`, `message_start`, `message_update`, `message_end`, tool execution events, `turn_end`, `agent_end`, …). Semantic order matches the pi agent-loop oracle. (ADR-0008)

## runLoop

Double-while control flow: outer loop for follow-up drain; inner loop for tool batches and steering injection. (ADR-0008, implementation steps 2 and 7)

## streamAssistant

Function that calls `StreamFn`, keeps a **partial assistant message in the context array**, and emits start/update/end. The **only** provider effect boundary in the agent core. (ADR-0010)

## prepare (tool)

Validate args (zod) + `beforeToolCall`. No tool body side effects. May block the call (error toolResult). (ADR-0009, ADR-0013)

## execute (tool)

`tool.execute(...)`. The **only** tool-body effect boundary. (ADR-0010)

## after (tool)

`afterToolCall` merge overrides onto the tool result before toolResult message emission. (ADR-0009)

## toolResult

Transcript message recording a tool outcome (success or error), appended after prepare/execute/after. (step 4)

## Parallel three-phase

1. Prepare all calls sequentially  
2. Execute allowed calls concurrently  
3. Emit tool-result artifacts in assistant source order (execution-end may follow completion order)

Matches pi semantics. (ADR-0008)

## Steering queue

Messages delivered at inner-loop drain points (after a turn, before the next assistant call), subject to `steeringMode` (`all` | `one-at-a-time`). (step 7)

## Follow-up queue

Messages delivered only when the agent would otherwise stop (no more tools, no steering left), subject to `followUpMode`. (step 7)

## Prompt mutex

`prompt` / `continue` reject or throw while a run is active; use steer/followUp instead. (step 6)

## Effect sandwich (L5)

For each effect: **intent commit** → **effect** → **settle commit**. Crash recovery reads `op.state`. Not implemented in v0. (ADR-0010)

## op.state

Durable total program counter for the in-flight operation. L5 only. (ADR-0010)

## Semantic oracle

pi `packages/agent` agent-loop / Agent behavior used as the correctness reference without importing pi packages. Deviations require an ADR. (ADR-0001, ADR-0008)

## Responses API path

The single production HTTP stream implementation in `@z-agent/ai`: OpenAI Responses API streaming. (ADR-0005)

## StreamFn (injection)

Production uses Responses-backed `StreamFn`. Unit tests inject a private scripted `StreamFn` under `packages/agent/test/helpers/` — not a public package API.

## prepareNextTurn

Called after `turn_end` and before `shouldStopAfterTurn`. May replace context, model, or thinkingLevel for later provider calls in the same run. Does not write back to `Agent.state.thinkingLevel`. (ADR-0015)

## shouldStopAfterTurn

If true after a completed turn, emit `agent_end` and skip steering/follow-up polls (the loop-start steering poll still happens). (ADR-0015)

## thinkingLevel

`AgentState` reasoning request: `"off"` | `"minimal"` | `"low"` | `"medium"` | `"high"` | `"xhigh"` | `"max"`. `"off"` omits `StreamOptions.reasoning`. Not `thinkingBudgets`. (ADR-0015)

## agentLoop / agentLoopContinue

EventStream wrappers around `runAgentLoop` / `runAgentLoopContinue`. Completing event is `agent_end`. Wrapper catches rejection so `result()` does not hang. (ADR-0015)
