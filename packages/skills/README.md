# @z-agent/skills

Pure Skills primitives for Z Agent: `SKILL.md` parsing, local discovery,
conflict resolution, deterministic matching, branch-state reduction, bounded
context rendering, and confined resource reads. Filesystem adapters live here;
session and command effects remain in `@z-agent/cli`, and `@z-agent/agent` does
not depend on this package.

## Skill Format

Each skill is a directory containing a `SKILL.md` with YAML frontmatter:

```md
---
name: code-review
description: Review code for correctness, security, and regressions.
metadata:
  keywords: [review, security, regression]
  file-globs: ["**/*.ts", "**/*.tsx"]
allowed-tools: read grep
disable-model-invocation: false
---

# Instructions
...
```

`name` and `description` are required. A Markdown H1 is not a metadata fallback.
`allowed-tools` is retained for display as advisory metadata only; it never
adds, removes, or pre-authorizes tools. `disable-model-invocation: true` excludes
a skill from automatic matching but does not prevent explicit invocation.

## Discovery and Resolution

Default discovery reads exactly these sources:

1. Project manifest: `{cwd}/.pillow/skills.json`
2. Project conventional root: `{cwd}/.pillow/skills`
3. User manifest: `$PILLOW_HOME/skills.json`
4. User conventional root: `$PILLOW_HOME/skills`

That order is also conflict precedence. Name collisions and duplicate canonical
paths produce diagnostics. Conventional roots recurse deterministically, stop
below a directory containing `SKILL.md`, skip hidden directories and
`node_modules`, and honor `.gitignore`, `.ignore`, and `.fdignore`.

Manifest entries may reference a directory, an exact `SKILL.md`, or a glob.
Absolute paths and lexical `..` escapes are rejected. Every canonical target
must remain below the manifest directory, including after symlink resolution.
There is no remote registry, installation, file watcher, or implicit script
execution.

## Matching and State

`matchSkills` scores only a new user request and explicit path hints using name,
`metadata.keywords`, description, and `metadata.file-globs`. Matching is local,
deterministic, and explainable. Defaults allow at most two new activations per
turn and eight active skills per session. Hidden, stale, already-active, and
manual-off skills are handled explicitly in match results and diagnostics.

`reduceSkillState` projects `skill_activation`, `skill_deactivation`, and
`skill_mode` nodes into a branch-local active set, manual-off tombstones, and
mode. Skill bodies and invocation arguments are not persistent state.
`reconcileSkillState` requires name, canonical path, and content hash to match;
it never silently rebinds an active identity to a same-named replacement.

The modes are:

- `progressive` (default): render metadata and load a body only for an explicit
  invocation or `skill_read` request.
- `full`: inject complete active bodies that fit the dynamic request budget.
- `index`: render metadata only.

## Rendering and Resources

The renderers produce escaped `<available_skills>`, `<active_skills>`, and
`<matched_skills>` sections plus an optional complete explicit-invocation block.
Private canonical paths are not rendered. Allocation is bounded by the model
context window, output reserve, safety reserve, and a 15% skills cap. Bodies and
entries are included whole or omitted with `budget_exceeded`; they are never
silently truncated.

`readSkillResource` accepts an indexed skill name and a relative path, defaulting
to `SKILL.md`. It reads bounded UTF-8 text and supported images only from that
skill's directory. Absolute paths, `..` traversal, directories, unindexed names,
and canonical symlink escapes are rejected. The CLI exposes this through the
read-only `skill_read` tool without changing the ordinary coding-tool jail.

Skill content is always untrusted supplemental context. It cannot override
system policy, `AGENTS.md`, tool schemas, confirmations, path jail, or agent
effect boundaries.

## Public Surface

The package exports:

- `discoverSkills`, `parseSkill`, and `resolveSkillConflicts`
- `matchSkills`, `reduceSkillState`, and `reconcileSkillState`
- `formatAvailableSkills`, `formatActiveSkills`, `formatMatchedSkills`,
  `formatSkillInvocation`, and `renderSkillContext`
- `readSkillBody`, `readSkillResource`, and `SkillResourceError`
- the corresponding descriptor, index, state, diagnostic, budget, render, and
  filesystem adapter types
