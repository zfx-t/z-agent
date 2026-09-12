# @z-agent/agent

In-memory agent control loop for Z Agent.

## v0 surface (practical core)

- AgentMessage + emit
- Double-while runLoop
- streamAssistant (partial in array)
- Tools: prepare → execute → after (sequential + parallel three-phase)
- Agent shell: prompt mutex, subscribe, abort
- Steering + follow-up queues, with an optional safe-boundary queued-message preparation hook
- continue, prepareContext, transformContext, convertToLlm, before/afterToolCall, terminate batch, length-truncated tool batch failure
- AgentTool → LLM Tool (JSON Schema) at streamAssistant
- prepareNextTurn / shouldStopAfterTurn, thinkingLevel, addedToolNames passthrough
- agentLoop / agentLoopContinue EventStream wrappers

## Effect boundaries

| Effect | Function |
|--------|----------|
| Provider | `streamAssistant` → `StreamFn` |
| Tool body | `tool.execute` |

Coding tools (`createAllTools` / `createCodingTools`) live in this package. Durable intent/settle is `@z-agent/harness`.

## Bash policy

`createBashTool(cwd, options)` / `createAllTools(cwd, { bash: options })` accept:

| Option | Default | Effect |
|--------|---------|--------|
| `env` | `{ mode: "scrub" }` | `buildChildEnv` policy: `scrub` drops `DEFAULT_SECRET_PATTERNS` names (protected keys always pass; `allow` > `deny`; `set` last); `inherit` copies the source |
| `timeout` | `{ defaultSeconds: 600, maxSeconds: 3600 }` | Missing `timeout` → default; above cap → clamped + `Note: timeout clamped to <n>s.`; expiry → `Timed out after <n> seconds` result with `exitCode: null` |
| `sourceEnv` | `process.env` | Source env the policy derives from (tests) |
| `kill` | `defaultKillProcessTree` | Process-tree killer (tests) |
