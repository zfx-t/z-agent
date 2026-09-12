# ADR-0029: Bash env scrub and default timeout

## Status

Accepted

## Context

The `bash` tool spawned its shell with `process.env` verbatim. Any
`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / cloud credentials exported in the
operator's shell were readable by every model-issued command — `env`,
`printenv`, or a plain `cat ~/.aws/credentials` equivalent. Separately,
`timeout` was optional with no default: a model that omitted it (or a command
that hung) ran until operator abort, stalling the turn.

## Decision

- New pure module `packages/agent/src/tools/bash-env.ts`:
  `buildChildEnv(source, policy, platform)` derives the spawn environment.
  Default policy `scrub` drops variables whose **name** matches
  `DEFAULT_SECRET_PATTERNS` (`_API_KEY$`, `_TOKEN$`, `_SECRET…`,
  `_PASSWORD$`, `_CREDENTIALS?$`, `_PRIVATE_KEY$`, `DATABASE_URL`, …,
  case-insensitive, full-key anchored).
- `PROTECTED_KEYS` (`PATH`, `HOME`, `USER`, `SHELL`, `LANG`, `LC_*`, `TERM`,
  `TMPDIR`, `TEMP`, `TMP`, `COMSPEC`, `SYSTEMROOT`, `PATHEXT`, `USERPROFILE`,
  `APPDATA`, `LOCALAPPDATA`, `PWD`) are never scrubbed; `allow` names win over
  `deny`; `set` is applied last. `mode: "inherit"` is the opt-out. On win32
  keys compare uppercase.
- `BashToolOptions` gains `env`, `timeout` (`Partial<BashTimeoutPolicy>`), and
  `sourceEnv` (test seam). `createAllTools`/`createCodingTools` accept
  `options.bash` and pass it through; `CodingToolsOptions` stays bash-free.
- Timeout policy: `defaultSeconds: 600`, `maxSeconds: 3600`. A model-provided
  `timeout` above the cap is clamped and the tool result is prefixed with
  `Note: timeout clamped to <n>s.` `timeout <= 0` remains an error. On expiry
  the tool **returns** `Timed out after <n> seconds` with
  `details.exitCode === null` (previously it threw). The child env is rebuilt
  per call so `set` and runtime env changes apply.
- Nothing about what was scrubbed (names or counts) reaches tool output.
- CLI: `--bash-timeout <1-3600>` sets `defaultSeconds`;
  `--bash-env scrub|inherit` selects the policy. `/status` shows
  `bash: timeout <d>s/<m>s, env <mode>`. The `timeout` schema description now
  states the default and cap; argument names unchanged so sessions replay.
- System prompt gains one sentence: bash commands have a default timeout;
  long jobs pass `timeout` explicitly or run in the background.

## Consequences

- `gh`, `aws`, and similar tools inside bash lose ambient credentials —
  intended. `--bash-env inherit` and the `allow`/`set` policy fields are the
  escape hatches.
- Long-running commands without `timeout` now end at 600s instead of hanging
  the turn; the process tree is killed as on abort.
- Timeout is a normal tool result, not an error toolResult — the model sees
  the `Timed out` line plus any captured partial output.

## Alternatives

- Allowlist env (rejected: breaks nvm/pyenv/cargo/Nix/direnv/proxy variables
  that build toolchains rely on; denylist only touches secret-shaped names)
- Value-pattern scrubbing (rejected: false positives on arbitrary strings,
  per-entry cost, still leaks names)
- Credential store only, env untouched (rejected: does not remove the
  inherited environment the operator already exported)
- No default timeout / keep throw-on-timeout (rejected: hung commands stall
  turns; a result preserves partial output and keeps the loop moving)
