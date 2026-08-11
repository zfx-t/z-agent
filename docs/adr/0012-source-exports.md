# ADR-0012: TypeScript source exports

## Status

Accepted

## Context

v0 is private and unpublished. Emitting `dist/` on every change slows the ai↔agent feedback loop.

## Decision

- `"type": "module"`
- `package.json` `exports` point at `src/**/*.ts`
- Relative imports use `.ts` extensions
- Publish-time `dist` build deferred

## Consequences

- Consumers need TS-aware resolution or Node strip-types
- No dual src/dist drift in v0

## Alternatives

- Always build dist
- Conditional exports for dev vs publish
