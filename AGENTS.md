# Z Agent — development rules

## What this is

Clean-room agent runtime (`@z-agent/agent`) + LLM protocol package (`@z-agent/ai`).
Semantic oracle: pi `agent-loop` / `Agent` (no `@earendil-works/*` dependency).

Decisions live in `docs/adr/`. Terms live in `docs/glossary.md`.

## Conversational style

- Short, technical, no fluff, no emojis in commits
- Answer questions before editing when the user is asking

## Code quality

- Read files before wide changes
- No `any` unless necessary
- No inline/dynamic imports for types or runtime in library code
- **Erasable TypeScript only** (`erasableSyntaxOnly`): no parameter properties, `enum`, `namespace`, `import =`
- Relative imports use `.ts` extensions
- Direct dependencies pinned to exact versions

## Effect boundaries (L5-ready shape)

Only these may perform external effects in the agent core:

1. `streamAssistant` — consume `StreamFn` (provider)
2. `tool.execute` — run a tool body

`validate`, `before`/`after`, `emit`, message array mutation, queue drains are not effects.
No `op.state` / durable storage until L5 (`@z-agent/harness`).

## Build / install

- Node `>=22`
- `npm install --ignore-scripts`
- v0 packages export TypeScript source (`exports` → `src/`)
- After code changes: `npm run check` (full output). Fix all issues.
- Do not run full test suites or builds unless requested; if you add/change a test file, run that test.

## Git

- Commit only when asked
- Stage explicit paths; never `git add -A` / `git add .`
- No `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash` that destroy other work

## Implementation order

1. AgentMessage + emit
2. runLoop double-while (tools only inner)
3. streamAssistant (partial in array + start/update/end)
4. tool prepare → execute → after → toolResult
5. sequential tools; then parallel three-phase
6. shell: prompt mutex, subscribe, abort
7. steering + follow-up queues
8. L5 durable sandwich (later package)
