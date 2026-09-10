# ADR-0023: Assistant Markdown via marked lexer

## Status

Accepted

## Context

Assistant replies are Markdown. `@z-agent/tui` currently wraps raw `entry.text`, so operators see `**`, fences, and link syntax. ADR-0016 forbids Ink, pi-tui, and native addons. `layout.ts` already owns cell-width wrap and semantic tokens, and `clean()` strips untrusted ANSI from transcript bodies.

## Decision

Lex assistant transcript text with `marked@18.0.11` (`gfm: true`, `breaks: true`) and paint a first-party Quiet Console rendering.

- Store raw Markdown on `TuiTranscriptEntry.text`.
- Sanitize with `clean()` before `lexer()`. Never call `marked.parse`.
- Wrap plain spans, then apply existing `Tone` plus italic/strike.
- Re-lex the full assistant buffer on each paint. `LineScreen` replaces rows in place.
- Keep structure visible under `NO_COLOR` via ASCII markers (`#`, `-`, `` ``` ``, `│ `, `[image: alt]`).

## Consequences

- `@z-agent/tui` gains one exact-pinned dependency.
- Print mode, user/thinking/tool rows, and syntax highlighting stay out of scope until a later ADR.
- HTML tokens and `javascript:` / `data:` / `vbscript:` hrefs are dropped.

## Alternatives

- `marked-terminal` / `marked-terminal-renderer` (rejected: ANSI-string output, emoji/highlight/table deps, fights `clean()` and the AI gutter)
- Ink markdown (rejected: ADR-0016)
- Glow / Glamour binary or `@oakoliver/glamour` (rejected: native/external or unproven parser)
- Markdansi streamer (rejected: replaces wrap/theme; young)
- Hand-rolled GFM (rejected: worse lexer than `marked`)
