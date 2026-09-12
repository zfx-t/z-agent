# Architecture Decision Records

| ID | Title | Status |
|----|-------|--------|
| [0001](0001-clean-room.md) | Clean-room relative to pi | Accepted |
| [0002](0002-typescript-node.md) | TypeScript on Node | Accepted |
| [0003](0003-ai-package.md) | Parallel `@z-agent/ai` package | Accepted |
| [0004](0004-ai-v0-depth.md) | AI package v0 depth | Accepted |
| [0005](0005-responses-api.md) | OpenAI Responses API as sole HTTP stream | Accepted |
| [0006](0006-dual-message-layer.md) | AgentMessage vs LLM Message | Accepted |
| [0007](0007-repo-identity.md) | Repo path and npm scope | Accepted |
| [0008](0008-semantic-oracle.md) | pi semantic oracle | Accepted |
| [0009](0009-v0-surface.md) | v0 practical core surface | Accepted |
| [0010](0010-effect-boundaries.md) | Effect boundaries for L5 | Accepted |
| [0011](0011-toolchain.md) | npm / vitest / tsc / biome | Accepted |
| [0012](0012-source-exports.md) | TypeScript source exports | Accepted |
| [0013](0013-zod-tools.md) | zod for tool schemas | Accepted |
| [0014](0014-license-privacy.md) | MIT, private packages | Accepted |
| [0015](0015-post-v0-in-memory-surface.md) | Post-v0 in-memory oracle surface | Accepted |
| [0016](0016-coding-product.md) | Coding product surface (TUI-first) | Accepted |
| [0017](0017-thinking-sse-replay.md) | Responses thinking SSE + replay | Accepted |
| [0018](0018-coding-cli.md) | Coding CLI slice | Superseded |
| [0021](0021-l5-jsonl-harness.md) | L5 JSONL harness | Accepted |
| [0022](0022-pillow-home.md) | Pillow home and user config | Accepted |
| [0023](0023-tui-markdown.md) | Assistant Markdown via marked lexer | Accepted |
| [0024](0024-session-checkpoints.md) | Session checkpoints | Accepted |
| [0025](0025-extension-surface.md) | Command registry and extension surface | Accepted |
| [0026](0026-sqlite-op-state.md) | SQLite op.state backend | Accepted |
| [0027](0027-multi-provider.md) | Multi-provider stream dispatch | Accepted |
| [0028](0028-provider-retry-timeout.md) | Provider retry and stream timeouts | Accepted |
| [0029](0029-bash-env-timeout.md) | Bash env scrub and default timeout | Accepted |
| [0030](0030-l5-op-identity-settle.md) | L5 op identity, settle phase, and stream replay | Accepted (amends 0021) |
| [0031](0031-diagnostics-crash-guard.md) | Diagnostics log and crash guard | Accepted |

## Format

Each ADR: Context, Decision, Consequences, Alternatives considered.
