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

For each effect: **intent commit** → **effect** → **settle commit**. Crash recovery reads `op.state`. Implemented in `@z-agent/harness` (JSONL). (ADR-0010, ADR-0021)

## Semantic oracle

pi `packages/agent` agent-loop / Agent behavior used as the correctness reference without importing pi packages. Deviations require an ADR. (ADR-0001, ADR-0008)

## Responses API path

The single production HTTP stream implementation in `@z-agent/ai`: OpenAI Responses API streaming. (ADR-0005)

## StreamFn (injection)

Production uses Responses-backed `StreamFn`. Unit tests inject a private scripted `StreamFn` under `packages/agent/test/helpers/` — not a public package API.

## prepareNextTurn

Called after `turn_end` and before `shouldStopAfterTurn`. May replace context, model, or thinkingLevel for later provider calls in the same run. Does not write back to `Agent.state.thinkingLevel`. (ADR-0015)

## prepareContext

Generic pure hook called immediately before `transformContext`, `convertToLlm`,
and the provider request. It receives a provider-context snapshot and may return
a replacement context, but it must not perform filesystem, network, session, or
tool effects. The CLI uses it to attach an already-built immutable skills
snapshot; `@z-agent/agent` has no dependency on `@z-agent/skills`.

## shouldStopAfterTurn

If true after a completed turn, emit `agent_end` and skip steering/follow-up polls (the loop-start steering poll still happens). (ADR-0015)

## thinkingLevel

`AgentState` reasoning request: `"off"` | `"minimal"` | `"low"` | `"medium"` | `"high"` | `"xhigh"` | `"max"`. `"off"` omits `StreamOptions.reasoning`. Not `thinkingBudgets`. (ADR-0015)

## agentLoop / agentLoopContinue

EventStream wrappers around `runAgentLoop` / `runAgentLoopContinue`. Completing event is `agent_end`. Wrapper catches rejection so `result()` does not hang. (ADR-0015)

## Coding product

`@z-agent/cli` + `@z-agent/tui`. Tools live in `@z-agent/agent`. Path jail and bash/write/edit confirm are stricter than pi. (ADR-0016)

## Assistant Markdown

TUI-only presentation of `assistant` transcript text. `@z-agent/tui` lexes GFM with `marked` and paints Quiet Console markers. The stored message text stays raw Markdown. Print mode does not render Markdown. (ADR-0023)

## thinkingSignature

JSON string of a Responses reasoning item, replayed on later turns. (ADR-0017)

## Pillow home

On-disk product directory name `.pillow` (user + project). Replaces `.z-agent` as the long-lived home. User config is `~/.pillow/config.json` only. Optional `PILLOW_HOME` overrides the user directory. (ADR-0022)

## Model alias

Key in `~/.pillow/config.json` `models`. `--model` / `OPENAI_MODEL` resolve alias first, then raw `id`. (ADR-0022)

## Model settings

Live inspect/edit surface for the resolved catalog model: `contextWindow`, `maxTokens`, and `thinking`. `/model` updates the current Agent and skills budget. Alias-backed values write `~/.pillow/config.json`. Raw model ids stay session-only. (ADR-0022)

## Session tree

Append-only JSONL nodes with `id`/`parentId` under `~/.pillow/sessions`. Product persistence, not L5. (ADR-0016, ADR-0022)

## Compaction

When estimated tokens exceed `contextWindow - reserve`, or the last assistant `stopReason` is `length`, older leaf messages are summarized (via the existing `StreamFn`) and replaced by a summary plus a recent tail. (ADR-0016)

## Discovered skill

A valid `SKILL.md` metadata descriptor present in the current skills registry.
Discovery does not make the skill active and does not eagerly load its body.

## Active skill

A skill the current session branch intends to use. Activation is branch-local
and persistent, but does not imply that the body is present in every provider
request.

## Loaded skill

A skill body or resource read for one provider request. Loaded is ephemeral and
is not persisted as session state.

## Stale / unavailable skill

An active skill identity whose name, canonical path, and content hash cannot be
reconciled with the current registry. It remains visible for audit but is not
rendered to the provider or exposed through `skill_read` until reconciled.

## Manual-off tombstone

Session-local state written by explicit skill deactivation. It prevents the
automatic matcher from immediately reactivating that skill; explicit activation
clears the tombstone.

## Skill control node

A branch-aware `skill_activation`, `skill_deactivation`, or `skill_mode` JSONL
session node. Control nodes determine effective skill state but never enter
`Agent.state.messages` or the provider transcript.

## Skill context mode

`progressive` indexes metadata and loads bodies on demand, with an explicit
invocation body included for that request. `full` injects complete active bodies
when they fit the request budget. `index` renders metadata only. The mode is
persisted with a skill control node and defaults to `progressive`.

## Skill context snapshot

Immutable request-local data containing the registry version, effective active
state, matcher result, mode, budget decision, and any explicit invocation. A
running provider request keeps its snapshot even if a reload or activation is
queued.

## Skills / extensions / project trust

Skills are local, non-executable, untrusted supplemental instructions discovered
from `$PILLOW_HOME` and `{cwd}/.pillow` without project trust. Executable
extensions remain trust-gated, and extension confirmation hooks still run.
Project skills override user skills; `{cwd}/.agents` is not scanned. Skill
`allowed-tools` metadata is advisory only. (ADR-0016, ADR-0022)

## Path jail

`realpath` prefix check so coding tools cannot escape `cwd` unless `--no-jail`. Stricter than pi `resolveToCwd`. (ADR-0016)

## op.state

Per-operation durable counter written by `@z-agent/harness` (`intent` → `effect` → `done`). (ADR-0010, ADR-0021)
