# @z-agent/harness

L5 durable layer: **intent commit → effect → settle commit** with `op.state/{opId}` (ADR-0010, ADR-0021, ADR-0026).

Wraps `StreamFn` and `tool.execute`; does not rewrite the loop. Two `OpStore`
backends: `JsonlOpStore` (per-op JSON files) and `SqliteOpStore` (`node:sqlite`,
single `op.state.db`). CLI selects with `--durable-backend jsonl|sqlite`.
