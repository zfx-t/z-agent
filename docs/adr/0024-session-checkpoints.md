# ADR-0024: Session checkpoints

## Status

Accepted

## Context

The JSONL session tree (`id` / `parentId` / `leafId`) already stores abandoned branches. Product surfaces only listed session files and loaded the saved `leafId`. `rootToLeaf` truncated a missing parent and could loop on a cycle. Operators could not restore an earlier node or see that a restore left a sibling branch on disk.

## Decision

- A **checkpoint** is any session node. Restoring it sets `leafId` through existing `branch()`. The next append remains a child of that node. Sibling nodes stay in the JSONL and never join `messagesOnLeaf`.
- After picking a session file, the TUI shows a second picker of checkpoints (live path, current leaf, and off-path siblings). Cancel leaves the current session unchanged. Startup cancel of the checkpoint picker starts a new session instead of silently using the file's saved leaf.
- `inspectSession` refuses `duplicate_id`, `missing_leaf`, `missing_parent`, and `cycle`. Load/restore then shows a local error and does not install a truncated transcript. `--session` / `--resume` of a malformed file warn and open an empty session.

## Consequences

- `@z-agent/cli` owns restore; `@z-agent/tui` still only renders a string picker. `@z-agent/agent` stays filesystem-free.
- Skill control nodes remain checkpoints because `skillStateOnLeaf` follows the restored path.
- Visual tree chrome beyond picker rows is out of scope.

## Alternatives

- Live-path-only picker (rejected: hides branches the file still holds)
- Merge sibling messages into the transcript (rejected: mixes unrelated branches)
- Throw on malformed files and exit (rejected: match enter-and-warn)
