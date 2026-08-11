# ADR-0014: MIT and private packages

## Status

Accepted

## Context

Personal monorepo with no immediate public release requirement.

## Decision

- License: MIT
- Workspace and packages: `"private": true`
- No requirement to configure a git remote at init

## Consequences

- Safe to open later under MIT
- npm publish blocked until private flags change

## Alternatives

- Proprietary / no license file
- Public-ready README and remote from day one
