# Z Agent Skills Product Design

**Status:** Approved in design discussion; awaiting written-spec review before implementation

**Date:** 2026-08-27

**Scope:** Complete skills product for `@z-agent/skills`, `@z-agent/cli`, and the
generic pre-provider context seam in `@z-agent/agent`.

## 1. Summary

Z Agent will provide a progressive-disclosure skills system compatible with the
Agent Skills `SKILL.md` convention. Skills are discovered locally, indexed by
metadata, matched deterministically against new user requests, and activated for
the current session. Explicit commands, automatic matching, and an opt-in
full-body mode are all supported; the default is metadata indexing plus
on-demand body loading.

The implementation is split into a new `@z-agent/skills` package and thin CLI
integration. The package owns parsing, discovery, conflict resolution,
matching, activation reduction, resource validation, context rendering, and
diagnostic types. The CLI owns filesystem/session integration, command parsing,
TUI behavior, and persistence. The agent core remains unaware of skills and
continues to enforce its existing effect boundaries and tool semantics.

## 2. Confirmed Decisions

| Area | Decision |
| --- | --- |
| Default activation | Index first, then deterministic local on-demand matching |
| Supported activation paths | Explicit command, automatic matching, and opt-in full-body mode |
| Skill format | Agent Skills-compatible YAML frontmatter in `SKILL.md` |
| Sources | Local `.pillow` directories plus `.pillow/skills.json` manifests |
| Remote installation | Not part of this design |
| `allowed-tools` | Advisory metadata only; never authorization |
| Activation lifetime | Session-level persistent active set |
| Automatic matcher | Pure local deterministic scorer |
| Automatic limits | At most 2 new skills per turn and 8 active skills per session |
| Explicit arguments | Apply to the current invocation only |
| Body disclosure | `skill_read` capability, with explicit invocation body wrapper |
| Session persistence | Branch-aware skill control nodes, separate from transcript messages |
| Source precedence | Project overrides user; collisions produce diagnostics |
| Trust | Skills are discoverable/activatable without project trust; extensions remain trust-gated |
| User commands | `/skills`, `/skill`, `/reload`, and direct `/<skill-name>` syntax |
| Completion | Character-ranked slash completion with `Tab` cycling |
| Manifest paths | Glob support, confined to the manifest directory tree |
| Context budget | Dynamic token budget with conservative estimator fallback |

## 3. Goals and Non-goals

### Goals

- Make existing and shared Agent Skills resources usable without copying them
  into the project working tree.
- Keep ordinary provider context small through progressive disclosure.
- Make every automatic decision explainable and reproducible in tests.
- Persist activation intent across session resume and branches.
- Keep skill instructions below product system policy, `AGENTS.md`, tool
  confirmation, path jail, and durable effect rules.
- Expose useful runtime diagnostics instead of silently ignoring malformed or
  stale resources.
- Give TUI and future SDK consumers the same registry and matching semantics.

### Non-goals

- A remote skill registry, package installer, update service, or signature
  distribution system.
- Executing scripts as a skill-specific effect.
- Granting tools, bypassing confirmations, or changing path jail based on skill
  metadata.
- Making `@z-agent/agent` depend on filesystem, YAML, session, or CLI code.
- Replacing extensions, prompt templates, or project trust for other resource
  types.

## 4. Terminology and Runtime States

Every indexed skill has four independent states:

- **Discovered:** a valid metadata descriptor exists in the current registry.
- **Active:** the session intends to use the skill. Activation is persistent and
  branch-local.
- **Loaded:** the body or a referenced resource has been read for one provider
  request. Loaded is ephemeral and is not a session state.
- **Stale/unavailable:** an active identity cannot be reconciled with the
  current path and content fingerprint. It remains visible for audit but is not
  sent to the provider or exposed through `skill_read` until reconciled.

There is also a session-local **manual-off tombstone**. It prevents automatic
matching from immediately reactivating a skill after the user explicitly
disabled it.

The context mode is one of:

- `progressive` (default): metadata is indexed; active bodies are read through
  `skill_read` when the model needs them; explicit invocation includes the body
  for the current request.
- `full`: active skill bodies are injected into every provider request when they
  fit the dynamic budget. A body is included whole or omitted; it is never
  silently truncated.
- `index`: only available/active metadata is rendered. This is useful for
  debugging and for clients that want to provide their own resource reader.

All three modes are API-level capabilities. TUI users can change the session
mode with `/skills mode progressive|full|index`; the default remains
`progressive`.

## 5. Package Architecture

### 5.1 New package

Add `packages/skills` with package name `@z-agent/skills`. It exports TypeScript
source, uses erasable TypeScript syntax, and pins direct dependencies exactly.
The package may use a pinned YAML parser and a pinned glob implementation, but
its matching, conflict, reduction, budget, and rendering functions remain pure.

Suggested module boundaries:

- `types.ts`: descriptors, sources, metadata, state, diagnostics, budget, and
  render result types.
- `parse.ts`: frontmatter extraction, YAML parsing, schema validation, and
  body split.
- `discover.ts`: recursive directory discovery, ignore handling, manifest
  expansion, symlink/canonical checks, and source provenance.
- `resolve.ts`: precedence, canonical deduplication, name collision handling,
  and immutable index construction.
- `match.ts`: token normalization, path hints, scoring, caps, and reasons.
- `state.ts`: activation/deactivation/mode reducer and branch projection.
- `render.ts`: escaped metadata XML, active/matched sections, explicit body
  wrapper, and token-budget allocation.
- `resource.ts`: allowlisted resource resolution and the pure validation half
  of `skill_read`.
- `index.ts`: public exports only.

### 5.2 Public API shape

The initial public surface is the following. Implementations may add
backward-compatible fields, but these functions and their core semantics are
the v1 contract:

```ts
discoverSkills(options): Promise<DiscoverResult>;
parseSkill(raw: string, source: SkillSource): ParseResult;
resolveSkillConflicts(skills: SkillDescriptor[]): ResolveResult;
matchSkills(request: MatchRequest, index: SkillIndex, options?: MatchOptions): MatchResult;
reduceSkillState(nodes: SkillStateNode[]): SkillState;
formatAvailableSkills(index: SkillIndex, budget: Budget): RenderResult;
formatActiveSkills(state: SkillState, index: SkillIndex, budget: Budget): RenderResult;
formatSkillInvocation(skill: SkillDescriptor, body: string, args: string, budget: Budget): RenderResult;
readSkillResource(index: SkillIndex, skillName: string, relativePath?: string): Promise<SkillResource>;
```

The default filesystem discovery/resource reader is an adapter in this package,
not an effect in `@z-agent/agent`. Consumers may inject an in-memory reader for
tests or SDK use.

### 5.3 Agent seam

Add a generic pure hook to the agent loop configuration:

```ts
prepareContext?: (context: AgentContext) => AgentContext | Promise<AgentContext>;
```

`streamAssistant` awaits it immediately before `transformContext`,
`convertToLlm`, and the `StreamFn` call. It receives a read-only snapshot and
must return a new context when changing it. The hook is documented as pure and
must not perform filesystem, network, session, or tool effects; an async return
type exists only for composition with already-computed data. The CLI closes
over an immutable `SkillContextSnapshot` for each provider request and updates
that snapshot only at safe turn boundaries. A running provider request never
observes a mid-request reload or activation mutation.

No skill type or package import is added to `@z-agent/agent`.

## 6. Skill File Format

### 6.1 Required structure

Each skill is a directory containing `SKILL.md`:

```text
code-review/
  SKILL.md
  references/
  scripts/
  assets/
```

`SKILL.md` begins with YAML frontmatter:

```md
---
name: code-review
description: Review code for correctness, security, and regressions.
license: MIT
compatibility: Requires Node.js 22+
metadata:
  keywords: [review, security, regression]
  file-globs: ["**/*.ts", "**/*.tsx"]
allowed-tools: read grep
disable-model-invocation: false
---

# Instructions
...
```

The parser uses a structured YAML parser. A missing or empty `name` or
`description` makes the skill unavailable and emits a diagnostic. Other
standard validation violations are warnings and do not discard an otherwise
loadable skill:

- `name`: 1-64 characters, lowercase `a-z`, digits, and single hyphens; no
  leading/trailing hyphen or consecutive hyphens.
- `description`: non-empty and at most 1024 characters.
- `metadata.keywords`: optional string array; invalid values are ignored with a
  warning.
- `metadata.file-globs`: optional string array; invalid patterns are ignored
  with a warning.
- `allowed-tools`: parsed as a space-delimited string or string array and
  retained for display only.
- `disable-model-invocation`: only literal boolean `true` hides the skill from
  automatic/model invocation.

`license`, `compatibility`, and unknown metadata are retained in the descriptor
for display/future use. Unknown fields have no authorization or matching effect.

The parser imposes separate input-safety limits (frontmatter size, YAML nesting,
and collection sizes) to avoid parser denial of service. These limits are not a
substitute for provider token budgeting. A legacy file with only a Markdown H1
is not loaded; the diagnostic explains that frontmatter is required.

### 6.2 Resource semantics

References are resolved relative to the directory containing `SKILL.md`.
`skill_read` can read UTF-8 text and supported images under that directory, but
cannot execute files, list arbitrary directories, follow a symlink outside the
skill root, or access another indexed skill by path alias.

## 7. Discovery and Resolution

### 7.1 Discovery roots

The default roots are exactly:

- User conventional root: `$PILLOW_HOME/skills`.
- Project conventional root: `{cwd}/.pillow/skills`.
- User manifest: `$PILLOW_HOME/skills.json` when present.
- Project manifest: `{cwd}/.pillow/skills.json` when present.

`PILLOW_HOME` continues to override the user home. `.z-agent` migration is
handled by the existing Pillow-home code. `{cwd}/.agents` and ancestor
directories are not scanned.

### 7.2 Recursive directory rules

- A directory containing `SKILL.md` is a skill root; load that file and stop
  descending below it.
- Otherwise recurse into child directories.
- Skip hidden directories and `node_modules`.
- Honor `.gitignore`, `.ignore`, and `.fdignore` at each applicable root.
- Follow directory symlinks only when their canonical target remains inside the
  discovery root; broken links are warnings.
- Sort directory entries and glob results deterministically.

### 7.3 Manifest format and confinement

`.pillow/skills.json` is a standalone manifest:

```json
{
  "skills": ["./skills/**/*.md", "./shared/review"]
}
```

Manifest entries may point to a directory, a `SKILL.md`, or a glob. A glob may
match skill directories or files named exactly `SKILL.md`; other Markdown files
are ignored with a diagnostic. Relative paths are resolved against the directory
containing the manifest. Absolute paths and lexical `..` escapes are rejected.
After expansion, every canonical target must remain under that manifest
directory; a symlink escape is rejected even if the lexical path is inside. A
glob with no matches emits `glob_no_match` but does not fail startup. Manifest
parsing is additive to conventional discovery.

### 7.4 Precedence and provenance

Each descriptor carries:

- `scope`: `project` or `user`;
- `kind`: `manifest` or `conventional`;
- display path and private canonical path;
- skill root (`baseDir`);
- metadata and diagnostics;
- a cheap stat fingerprint (`mtimeMs` + size) for index refresh;
- an optional SHA-256 content hash. The hash is computed at activation or
  explicit body load using a bounded streaming read; discovery does not read
  full bodies.

Name resolution uses this deterministic rank:

1. project manifest;
2. project conventional;
3. user manifest;
4. user conventional;
5. canonical path lexical order as the final tie-break.

Only the highest-ranked descriptor for a name enters the active index. A
different canonical path with the same name produces `name_collision`; an
identical canonical path discovered twice produces `duplicate_path`.

## 8. Matching and Activation

### 8.1 Explicit activation

`/<skill-name> [args]` and `/skill <skill-name> [args]` resolve an exact skill
name. Explicit activation can select hidden (`disable-model-invocation`) skills
and overrides automatic matching. It writes an activation control node and
starts one agent request. `args` is appended only to that request's invocation
block and is never stored as persistent skill configuration.

`/skill -<skill-name>` writes a deactivation node and a manual-off tombstone.
`/skill all` activates currently valid, model-invocable skills in the registry's
deterministic order (source rank, normalized name, canonical path) until the
session cap is reached. Hidden skills still require their own explicit command.
An explicit activation clears that skill's manual-off tombstone. A bare or
malformed `/skill` command is a recognized command error, not ordinary user
text; an unrelated unknown `/...` line remains ordinary user text.

### 8.2 Automatic matching

Before a new user, steering, or follow-up message enters a provider request,
the CLI passes only that message text and explicit path hints to the pure
matcher. Assistant, tool, system, and skill-body text are never used as match
input. Path hints are conservative tokens that look like explicit file paths or
extensions; the matcher does not scan the repository.

Normalization applies Unicode NFKC, lowercasing, and tokenization on
non-alphanumeric boundaries. A deterministic score is calculated from:

| Signal | Weight |
| --- | ---: |
| Exact skill-name phrase | 100 |
| Name token overlap | 40 per token, capped at 80 |
| Exact keyword overlap | 30 per token, capped at 60 |
| Description token overlap | 6 per token, capped at 30 |
| Explicit path matching `file-globs` | 35 per matching glob, capped at 70 |

The effective score is the sum capped at 100. A score below 35 is not a match.
Candidates sort by score descending, source rank descending, normalized name,
then canonical path. At most two new skills are activated for one turn and at
most eight skills can be active in one session. Candidates excluded by a cap,
threshold, `disable-model-invocation`, stale state, or manual-off produce an
explainable diagnostic/reason when requested by `/skills` or verbose output.

Automatic activation is persistent, just like explicit activation. A manual-off
tombstone blocks automatic reactivation until the user explicitly activates the
skill again.

### 8.3 Full-body mode

`progressive` is the default. In `full` mode, active bodies are loaded before
each provider request and injected whole when budget permits. Automatic matching
still determines which skills become active; full mode does not silently turn
all discovered skills on. `/skill all` plus `full` mode is the explicit opt-in
equivalent of full injection. `index` mode renders metadata only.

## 9. Session State and Branching

Skill control nodes are first-class JSONL nodes and are not provider messages:

```ts
type SkillSessionNode =
  | {
      type: "skill_activation";
      schemaVersion: 1;
      id: string;
      parentId: string | null;
      createdAt: number;
      skillName: string;
      canonicalPath: string;
      sourceScope: "project" | "user";
      sourceKind: "manifest" | "conventional";
      contentHash: string;
      origin: "explicit" | "automatic" | "all" | "command";
    }
  | {
      type: "skill_deactivation";
      schemaVersion: 1;
      id: string;
      parentId: string | null;
      createdAt: number;
      skillName: string;
      canonicalPath?: string;
      origin: "explicit" | "command" | "reload" | "reset";
    }
  | {
      type: "skill_mode";
      schemaVersion: 1;
      id: string;
      parentId: string | null;
      createdAt: number;
      mode: "progressive" | "full" | "index";
    };
```

`reduceSkillState(rootToLeaf(nodes))` returns active identities, manual-off
names, current mode, and audit diagnostics. The reducer is pure and branch
aware:

- A branch inherits the effective state at its branch point.
- `/new` starts with an empty skill state.
- `/reset` clears transcript, active skills, manual-off tombstones, and mode
  back to `progressive`.
- Resume restores the branch's effective state, then reconciles it against the
  current registry.
- Compaction never summarizes, removes, or rewrites skill control nodes.
- Missing, changed, or re-bound identities remain visible as stale audit state;
  they are not silently replaced by a same-name descriptor.
- `/reload` atomically reconciles active identities. Unchanged identities stay
  active; changed identities become stale until explicitly accepted; removed
  identities receive a deactivation node.

The body and invocation arguments are never stored in these nodes. TUI may
render a transient collapsed invocation entry, but it is not an ordinary user
message and is not sent again on resume.

## 10. Provider Context and Progressive Disclosure

The CLI builds an immutable `SkillContextSnapshot` immediately before every
provider request. It contains the registry version, active state, matcher
results, mode, budget decision, and any explicit invocation body for that
request.

The generated supplemental context has these sections, in order:

```xml
<available_skills>...</available_skills>
<active_skills>...</active_skills>
<matched_skills>...</matched_skills>
```

Each visible entry includes escaped name, description, display location, source
scope, and a `skill_read` usage hint. `disable-model-invocation` skills are
omitted from model-facing `available_skills` and `matched_skills`, but remain in
`/skills` output and are explicitly addressable. Private canonical paths are
never rendered; `skill_read` resolves by indexed name and relative resource.

An explicit invocation adds a separate supplemental block for the current
request:

```xml
<skill name="code-review" location="~/.pillow/skills/code-review/SKILL.md">
References are relative to the skill directory.

...complete SKILL.md body...

<user_instructions>security</user_instructions>
</skill>
```

Skill blocks are untrusted supplemental instructions. They cannot override
product/system policy, `AGENTS.md`, tool schemas, confirmation rules, path jail,
or effect boundaries.

### 10.1 `skill_read` capability

The CLI registers a read-only `skill_read` tool backed by the skills package.
Its conceptual schema is:

```ts
{
  skill: string;
  path?: string; // relative to the selected skill baseDir; defaults to SKILL.md
}
```

Validation requires an indexed skill name, a relative path, a regular file,
UTF-8 text or supported image, and a canonical target inside that skill's
`baseDir`. It rejects absolute paths, `..` escapes, symlink escapes, arbitrary
directory reads, and unindexed names. It does not grant access to the rest of
`~/.pillow` and does not bypass ordinary `read` jail behavior. It is a normal
read-only tool and does not require confirmation.

### 10.2 Dynamic token budget

`TokenEstimator` is an injectable interface. The default implementation is the
existing conservative `ceil(serializedChars / 4)` estimate; a provider may
inject a precise tokenizer later. For every request:

```text
available = contextWindow
  - estimate(base system prompt + transcript + tool schemas)
  - outputReserve
  - safetyReserve
```

`outputReserve` is `model.maxTokens` or 10% of `contextWindow` when absent.
`safetyReserve` is 5% of `contextWindow`. Skills may consume at most 15% of the
window. If `contextWindow` is missing, zero, or invalid, the skills-aware
provider path fails with an explicit configuration diagnostic rather than
injecting without a bound.

Allocation priority is:

1. explicit invocation body for the current request;
2. current-turn automatic match explanations/body (only in `full` mode);
3. active-skill metadata;
4. available-skill metadata.

An individual body must fit in full. XML entries are also included whole or
omitted. Omitted entries carry `budget_exceeded` diagnostics and are visible in
`/skills`; no instruction is silently truncated.

## 11. Commands, Slash Parsing, and TUI

### 11.1 Command precedence

The parser handles one submitted line as follows:

1. Built-in commands (`/new`, `/reset`, `/clear`, `/compact`, `/sessions`,
   `/status`, `/commands`, `/skills`, `/skill`, `/reload`) win.
2. An exact direct skill name (`/<skill-name>`) invokes that skill.
3. An unrecognized slash line is submitted as ordinary user text.

`/skill <name> [args]` is the explicit long form. `/skill -<name>` disables a
skill, `/skill all` activates all eligible skills, and `/skills [query]` lists
or filters the registry. `/skills mode <mode>` changes the branch-persisted
context mode.

### 11.2 Completion

When the editor's first token begins with `/`, TUI shows candidates from built-in
commands and skill names. Completion ranking is:

1. exact match;
2. case-insensitive prefix;
3. case-insensitive substring;
4. ordered fuzzy subsequence;
5. stable command-type/name ordering.

The suggestion popup has a fixed maximum height. `Tab` accepts the best match;
repeated `Tab` cycles forward, `Shift+Tab` cycles backward, and `Esc` cancels.
Only the command token is replaced; arguments and cursor-relative text remain
unchanged. Completion never activates a skill or calls the model.

### 11.3 Streaming command queue

While a provider run is active, slash commands are queued FIFO. They execute
after the current turn reaches its safe boundary and before the next steering
request. A queued `/reload` atomically updates the registry before later queued
skill commands. The current provider request keeps its immutable snapshot.
`/skills` and `/reload` display pending status rather than mutating a live
request. Ordinary text typed during a run continues to use the existing steering
queue and is auto-matched at the next request boundary.

Print/non-TTY mode reuses the same parser and explicit syntax but has no
completion UI. No new CLI flag or remote configuration surface is added in this
design.

## 12. Security and Trust

- Skills are treated as untrusted instructions, even when discovered locally.
- Discovery and activation of user/project skills do not depend on
  `ensureProjectTrust`, per the confirmed product policy. Extensions and other
  executable resources remain trust-gated.
- Existing `bash`, `write`, and `edit` confirmation behavior is unchanged.
- Existing path jail is unchanged for ordinary coding tools.
- `allowed-tools` is rendered as a hint only and cannot add, remove, or
  pre-authorize tools.
- Manifest lexical and canonical containment checks prevent traversal and
  symlink escapes.
- Canonical paths, hashes, and source provenance are retained for audit; private
  canonical paths are not exposed in model-facing XML.
- Frontmatter/body parsing has bounded input limits. Resource reads are bounded
  by the same estimator and a separate implementation-level I/O safety cap.
- No file watcher, network fetch, or implicit script execution is introduced.

This policy intentionally supersedes the current ADR-0022 statement that
skills and extensions share one trust gate. A follow-up ADR must record the
split explicitly before implementation lands.

## 13. Diagnostics and Reload

Diagnostics are structured and non-fatal by default:

```ts
type SkillDiagnosticCode =
  | "invalid_frontmatter"
  | "invalid_metadata"
  | "manifest_invalid"
  | "manifest_escape"
  | "glob_no_match"
  | "path_unreadable"
  | "duplicate_path"
  | "name_collision"
  | "body_changed"
  | "body_missing"
  | "budget_exceeded"
  | "activation_limit";
```

Every diagnostic includes severity, message, and when available path, skill
name, source, and registry version. A malformed skill does not prevent other
skills or the CLI from starting. An explicit invocation that cannot load a
complete body fails before a provider call and shows the diagnostic.

`/reload` constructs a new registry privately, completes all parsing, glob
expansion, canonicalization, conflict resolution, and diagnostics, then swaps it
in one operation. The old registry remains in use by an already-running
request. Active identities are reconciled by name + canonical path + content
hash; changed/missing entries are stale or deactivated with visible diagnostics.
Body cache entries are keyed by canonical path + content hash and naturally
invalidate after reload. There is no background watcher.

`/skills` shows name, description, active/hidden/stale state, origin, source,
display path, matcher score/reason, collision state, and budget/parse
diagnostics. Verbose print mode emits the same decisions in text form without
exposing API keys or private body content.

## 14. Data Flow

1. Startup discovers conventional roots and manifests and builds an immutable
   registry.
2. Session root-to-leaf control nodes reduce to active, manual-off, and mode
   state.
3. Registry identities are reconciled against the reduced state; stale entries
   are retained for audit but excluded from provider context.
4. Slash parsing handles explicit commands before ordinary prompt submission.
5. Ordinary user/steering/follow-up text is scored by the local matcher; up to
   two eligible skills are activated and persisted.
6. The CLI creates one immutable skills snapshot for the next provider request.
7. The agent's generic `prepareContext` hook adds the rendered skills sections
   without changing the live transcript.
8. `streamAssistant` calls the provider. Tools and all existing effect ordering
   remain unchanged.
9. After the turn, queued slash commands and skill state updates run at the
   safe boundary; the next request receives a new snapshot.
10. Session persistence appends control nodes separately from message nodes.

## 15. Tests and Verification

### `@z-agent/skills` unit tests

- Valid frontmatter, missing fields, validation warnings, unknown metadata, and
  parser safety limits.
- Recursive discovery stopping at skill roots; hidden/node_modules skips;
  ignore files; symlink and canonical path behavior.
- Manifest JSON, glob expansion, no-match diagnostics, lexical/canonical escape
  rejection, and deterministic ordering.
- Project-over-user precedence, manifest-over-conventional precedence, duplicate
  path and name collision diagnostics.
- XML escaping, display-path formatting, explicit invocation wrapper, and
  `disable-model-invocation` filtering.
- Matcher normalization, every score signal, threshold, stable ties, explicit
  path glob hints, hidden/manual-off filtering, 2-per-turn and 8-per-session
  caps, and explainable reasons.
- State reducer branch replay, deactivation tombstones, mode changes, stale
  identities, and reload reconciliation.
- Token budget allocation, whole-body refusal, index omission order, estimator
  fallback, and invalid context-window diagnostics.
- `skill_read` allowlist, relative traversal rejection, symlink escape, image/
  text handling, and unindexed resource rejection.

### CLI/TUI integration tests

- Built-in/direct skill command precedence and unknown slash passthrough.
- `/skill` arguments are current-request-only; hidden skills remain explicitly
  callable.
- `/skills` filtering/status, `/skills mode`, `/reload`, pending command FIFO,
  and print-mode parsing.
- Character-ranked completion, `Tab`/`Shift+Tab` cycling, `Esc`, fixed popup
  bounds, and argument preservation.
- Skills load regardless of project trust while extensions remain gated.
- Session resume, branch rollback, `/new`, `/reset`, compaction, stale hash,
  and missing-skill diagnostics.

### Agent regression tests

- `prepareContext` runs immediately before each provider request, including
  first turn, post-tool turn, steering, and follow-up requests.
- A request uses one immutable context snapshot even if reload occurs during the
  stream.
- No skill control node enters `Agent.state.messages` or provider transcript.
- Existing stream/tool effect boundaries, ordering, abort behavior, and tests
  remain unchanged.

After implementation, run changed tests and `npm run check` as required by
`AGENTS.md`. Do not run the full suite merely because the design document was
added.

## 16. Implementation Order

1. Add `@z-agent/skills` package scaffolding, exact dependencies, public types,
   YAML parser, and diagnostics.
2. Implement recursive discovery, manifests/globs, canonicalization, source
   precedence, and index tests.
3. Implement matcher, activation reducer, renderers, estimator/budget, and
   resource validation.
4. Extend `@z-agent/agent` with the generic pure `prepareContext` seam and
   focused regression tests.
5. Extend sessions with skill control nodes and branch-aware reduction.
6. Replace the eager CLI loader with a registry/manager, add `skill_read`, and
   wire dynamic snapshots to the agent.
7. Add slash parsing, direct skill invocation, `/skills`, `/reload`, mode
   control, streaming command queue, and print-mode support.
8. Add TUI completion/rendering and status/diagnostic views.
9. Update ADR-0022, glossary, package READMEs, and product docs; remove the old
   eager `packages/cli/src/skills.ts` behavior.
10. Run focused tests, `npm run check`, and a manual TUI/print smoke path.

## 17. Compatibility and Deliberate Deviations

- Old no-frontmatter skill files are rejected with migration diagnostics.
- Old sessions without skill nodes restore with an empty active set.
- Existing base coding system prompt remains; only the skills sections become
  dynamic per provider request.
- `.pillow` replaces `.z-agent`; `.agents` is never scanned.
- Project precedence is intentionally project-first, even where pi uses a
  different source order.
- Local deterministic matching and persistent activation are Z Agent additions;
  they are not borrowed as native pi behavior.
- Independent `.pillow/skills.json` manifests replace package-manager resource
  discovery for this product slice.
- `skill_read` is a constrained resource capability instead of widening the
  ordinary read tool's jail.
