# @z-agent/agent

In-memory agent control loop for Z Agent.

## v0 surface (practical core)

- AgentMessage + emit
- Double-while runLoop
- streamAssistant (partial in array)
- Tools: prepare → execute → after (sequential + parallel three-phase)
- Agent shell: prompt mutex, subscribe, abort
- Steering + follow-up queues
- continue, transformContext, convertToLlm, before/afterToolCall, terminate batch, length-truncated tool batch failure
- AgentTool → LLM Tool (JSON Schema) at streamAssistant
- prepareNextTurn / shouldStopAfterTurn, thinkingLevel, addedToolNames passthrough
- agentLoop / agentLoopContinue EventStream wrappers

## Effect boundaries

| Effect | Function |
|--------|----------|
| Provider | `streamAssistant` → `StreamFn` |
| Tool body | `tool.execute` |

Durable intent/settle lives in a future `@z-agent/harness` package.
