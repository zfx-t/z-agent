# ADR-0028: Provider retry and stream timeouts

## Status

Accepted

## Context

A transient provider failure — `429`, `5xx`, or a socket reset before the
first SSE event — ended the turn immediately with an opaque `error` message.
Worse, a stream that stopped emitting events while keeping the socket open
hung the turn until operator abort. Both are routine on rate-limited or flaky
endpoints (burst limits, gateways, proxies), and neither surfaced an
actionable cause.

## Decision

- New pure modules in `@z-agent/ai`:
  - `retry.ts` — `RetryPolicy` (`maxAttempts` 3 = 1 initial + 2 retries,
    `baseDelayMs` 500, `maxDelayMs` 8_000), `parseRetryAfter`,
    `computeBackoff` (`min(max, base * 2^(attempt-1)) * jitter`, jitter
    uniform `[0.5, 1.5)`), `fetchWithRetry`. Sleep and random are injectable.
  - `timeouts.ts` — `StreamTimeouts` (`headersMs` 60_000 from fetch start to
    response headers, `idleMs` 120_000 between SSE events; `0` disables),
    `StreamTimeoutError`, `linkAbort`, `withHeadersTimeout`,
    `withIdleTimeout`.
- Retryable: HTTP `408/409/425/429/500/502/503/504`, fetch network errors
  (`TypeError`, `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `EAI_AGAIN`),
  headers timeout. `Retry-After` (seconds or HTTP-date) overrides the
  computed delay, still capped by `maxDelayMs`. Everything else fails at
  once; nothing retries after the first SSE event — `fetchWithRetry` resolves
  before `stream.push({ type: "start" })`, so partial output can never be
  duplicated.
- All three adapters share the same wiring through `ProviderHttpConfig`
  (`fetch`, `retry`, `timeouts`, `onRetry`) resolved by `resolveHttpConfig`.
  `retry: false` disables retry; `StreamOptions`/`StreamFn` signatures are
  unchanged and no adapter has local retry logic.
- Timeouts and exhausted retries encode as `stopReason: "error"` with exact
  strings: `<Adapter> HTTP <status> <statusText>: <detail>` (`after N
  attempts` suffix when N > 1), `Timed out waiting for response headers
  after 60s`, `Stream idle for 120s`. Idle abort runs through a `linkAbort`
  child signal, so `isAbortError(error, callerSignal)` still separates user
  abort from timeout; caller abort wins during backoff, headers wait, and
  idle wait.
- CLI: `--no-retry` opts out. Under `--verbose` each retry prints
  `[retry <attempt>/<maxAttempts> in <delay>ms: <reason>]` to stderr.
  `@z-agent/ai` never writes to stdout/stderr; `onRetry` is the only
  visibility channel.

## Consequences

- A `429` with `Retry-After` costs one bounded sleep and is invisible
  outside `--verbose`; a hung stream now ends the turn with `Stream idle
  for 120s` instead of hanging until Ctrl-C.
- `FetchWithRetryInput` gained an `httpErrorPrefix` field beyond the plan's
  contract map — the adapter label must reach the final error message and no
  other channel existed.
- `Anthropic Messages` replaces `Anthropic` as the HTTP error prefix so all
  three adapters name their dialect uniformly.
- No retry after `start`, no resumable streams, no cross-turn retry budget,
  no circuit breaker — the failure model stays per-request.

## Alternatives

- SDK-level retry (rejected: we own the fetch layer; a vendor SDK would
  hide `Retry-After` handling and add a dependency)
- Retry after `start` with dedupe (rejected: partial output replay breaks
  the event protocol; the stream boundary makes it unnecessary)
- Circuit breaker / retry budget across turns (rejected: per-request
  bounds are enough for the CLI slice; revisit with L5 durability)
- Per-call `StreamOptions` retry fields (rejected: the contract is
  per-factory `ProviderHttpConfig`; per-call knobs would complicate the
  oracle contract)
