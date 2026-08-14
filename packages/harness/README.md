# @z-agent/harness

L5 durable layer: **intent commit → effect → settle commit** with `op.state/{opId}` (ADR-0010, ADR-0021).

JSONL backend only. Wraps `StreamFn` and `tool.execute`; does not rewrite the loop.
