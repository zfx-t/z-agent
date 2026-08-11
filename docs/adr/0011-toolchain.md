# ADR-0011: Toolchain

## Status

Accepted

## Context

Need install, test, and check commands that match the author’s pi workflow.

## Decision

- Package manager: npm workspaces
- Tests: vitest
- Types: `tsc --noEmit` (erasable TS)
- Lint/format: biome
- Direct deps: exact version pins
- Install: `npm install --ignore-scripts`

## Consequences

- Familiar commands
- Lockfile must be reviewed like code

## Alternatives

- pnpm
- node:test only
