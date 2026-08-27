# ADR-0022: Pillow home and user config

## Status

Accepted

## Context

The coding product currently stores user state under `~/.z-agent` and project state under `{cwd}/.z-agent` / `{cwd}/.agents`. Model, base URL, and thinking level are resolved from CLI flags and `OPENAI_*` env vars only. A file-backed config is required so later work can read models, aliases, thinking, and context limits without re-deriving them each launch.

## Decision

- **On-disk identity is `.pillow` everywhere** (user + project). Old `.z-agent` is not a long-lived dual home.
- **Product identity stays Z Agent:** bin `z-agent`, npm scope `@z-agent/*`. `.pillow` is the directory name only.
- **One-shot migrate:** if the target `.pillow` is missing and `.z-agent` exists, copy (do not delete) then read/write only `.pillow`. Same rule for `~` and `{cwd}`.
- **Drop `{cwd}/.agents`.** Project skills/extensions only from `{cwd}/.pillow/{skills,extensions}`.
- **Config is user-only:** `~/.pillow/config.json`. Project `.pillow` does not carry a config file. `PILLOW_HOME` overrides the user directory (tests / ops).
- **Precedence (when a model actually resolves):** CLI flag > environment variable > `config.json` > built-in default for *non-model* fields (`baseUrl`, `apiKey`, `contextWindow`, `maxTokens`).
- **Secrets:** `apiKey` is optional in the file. `0600` on write. Never log or render the value. Env/flag still win.
- **Shape:** alias catalog. `{ version, defaultModel, models: { alias: { id, baseUrl?, apiKey?, thinking?, contextWindow?, maxTokens? } } }`. `--model` / `OPENAI_MODEL` match alias first; if no alias, treat the string as a raw model `id`.
- **No file-level `defaults`.** Omitted fields on an alias fall through to env then built-in. Omitted `thinking` keeps the current model-id heuristic.
- **File contents:** model catalog only. No jail / confirm / durable / sessionDir.
- **Missing file:** create `~/.pillow` if needed; write a `0600` starter `config.json` (one `gpt-4.1-mini` alias, no key). Never overwrite an existing file.
- **No `--thinking` flag.** Thinking comes from the resolved alias field, else the model-id heuristic.
- **Broken catalog / no resolvable model:** still enter TUI or print. Warn that no model is in use. Do **not** silently fall back to `gpt-4.1-mini`. Provider calls refuse until the user fixes the file or passes a usable `--model` / `OPENAI_MODEL`.

## Consequences

- Session / skills / extensions / trust / harness paths all move off `.z-agent`.
- CLI and package names do not change (ADR-0007 stands).
- First launch after this ADR may copy `.z-agent` → `.pillow`; leftover `.z-agent` is backup only.
- `{cwd}/.agents` is no longer a search path.
- Docs and tests that hard-code `.z-agent` must follow the final path set.
- Smoke tests that only set `OPENAI_API_KEY` still work: starter config supplies a model.

## Alternatives

- Config-only `~/.pillow/config.json` (rejected by owner)
- User-home `.pillow`, keep project `.z-agent` (rejected by owner)
- File-level `defaults` inheritance (rejected by owner)
- Product switches in `config.json` (rejected by owner)
- `--thinking` flag (rejected by owner)
- Exit 2 on bad config (rejected by owner: enter + warn, no model)
