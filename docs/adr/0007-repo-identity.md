# ADR-0007: Repo path and npm scope

## Status

Accepted

## Context

Need a home directory and package names before scaffolding.

## Decision

- Path: `/home/zeroth/ForMe/z-agent`
- npm scope: `@z-agent/*`
- Packages: `@z-agent/ai`, `@z-agent/agent`; later `@z-agent/harness`

## Consequences

- Sibling to `pi` under `ForMe`
- Clear room for L5 package name

## Alternatives

- `zagent` / `@zagent/*`
- ZOS-branded path
