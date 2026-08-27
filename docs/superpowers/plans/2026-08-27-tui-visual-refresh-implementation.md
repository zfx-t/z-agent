# TUI Visual Refresh — Implementation Plan

**Status:** Implemented; verification evidence is recorded in
`docs/evidence/tui-inline-inspector-evidence.json`.

## Outcome Contract

**User:** Coding-agent operator.
**Real entrypoint:** `npm run z-agent` in an interactive TTY.
**Trigger:** While an agent has produced one or more tool events, press `Tab`,
select a tool with `Up`/`Down`, and press `Enter`.
**Observable success:** The focused tool remains in the chronological,
single-column transcript and expands directly below itself with a bounded
summary. `Left`/`Right` switch its available detail views; `Esc` returns the
operator to the editable composer.
**Non-goals:** Mouse support, persistent side inspector, changing agent-core
effects or tool execution, theme marketplace.
**Constraints:** TypeScript must remain erasable; imports use `.ts`; no new
effect path inside `@z-agent/agent`; `NO_COLOR` must preserve all state
semantics; 80x24 remains usable.
**Proof:** Focused TUI tests, full `npm run check`, then an interactive TTY
journey with a configured model and a real tool invocation. Create an outcome
evidence manifest only after the journey is observed.

## Milestone 1 — Keyboard Inline Summary (first vertical slice)

Deliver the smallest end-to-end visible journey: an existing tool lifecycle
entry can be focused from the live editor and expanded as an inline **Summary**
without affecting the CLI-to-agent event path.

1. Extend `packages/tui/src/model.ts` with erasable types for:
   - editor versus transcript focus;
   - selected and expanded tool-call IDs;
   - inline inspector view (`summary`, `output`, `diff`);
   - optional structured tool input retained alongside the safe `argsText`
     display string; and
   - layout-owned bounded-detail scroll offset.
   Keep the existing transcript/tool data serializable and use `unknown` rather
   than `any` for source tool input.
2. Add a pure helper module, for example `packages/tui/src/tool-detail.ts`, to:
   - identify available views for a `TuiToolSnapshot`;
   - build compact, human-readable Summary rows; and
   - handle known `read`, `grep`, `find`, `edit`, `write`, and `bash` inputs
     with type guards and a generic fallback.
   This isolates renderer decisions from terminal input handling.
3. In `packages/tui/src/session.ts`, add explicit focus and selection state.
   `Tab` enters transcript focus and selects the latest tool; `Up`/`Down` move
   only across tool entries; `Enter` toggles one expanded tool; `Esc` restores
   editor focus. Preserve selected/expanded IDs when tool lifecycle events
   update in place. Confirmation and picker handling remain higher priority
   than this focus state.
4. Pass the new view state to `renderFrame` during `repaint()`. Retain the
   current `appendToolStart`, `appendToolUpdate`, and `appendToolEnd` public
   APIs so `packages/cli/src/interactive.ts` remains compatible for this
   milestone.
5. Replace the wide-only `splitBody` decision in
   `packages/tui/src/layout.ts` with a single-column transcript renderer.
   Render selected tool rows with a focus rail/surface and render the Summary
   immediately after the expanded row. Keep details within a fixed row budget
   so the composer remains visible.
6. Update `packages/tui/test/tui.test.ts` first: unit-test frame text for an
   inline Summary, selected-row indication, collapsed state, 80x24 row/width
   bounds, and monochrome labels. Add `InteractiveTui` key tests for
   `Tab → Down → Enter → Esc`; retain the existing prompt-history test as
   regression coverage for editor focus.

**Milestone evidence:** Unit tests produce a single-column expanded summary;
an interactive TTY displays the same flow against a real tool event.

## Milestone 2 — Output, Diff, and Detail Navigation

Turn the inline Summary into useful progressive disclosure without exposing
unbounded raw data in the transcript.

1. Extend `packages/tui/src/keys.ts` with explicit `pageUp` and `pageDown`
   keys, including common CSI forms. Preserve incomplete escape-sequence
   buffering in `parseInputChunk` and add parser tests for every accepted
   sequence.
2. Extend the session focus dispatch only when a tool is expanded:
   - `Left`/`Right` cycle only through views available for that tool;
   - `PgUp`/`PgDn` adjust bounded detail offset;
   - `Home`/`End` go to detail start/end;
   - `Enter` collapses the selected detail; and
   - opening another tool resets its view to Summary and its scroll offset to
     zero.
3. Use `tool-detail.ts` to show only real views:
   - `read`, `grep`, and `find`: Summary and Output;
   - `edit` and `write`: Summary, Diff when derivable from structured input,
     and Output when present;
   - `bash`: Summary and Output, including `exitCode`/truncation from details;
   - failures: Summary and output/failure detail when present.
   Do not fabricate a Diff from output. For `edit`, derive a bounded patch-like
   preview from the original `edits` input; for `write`, show a bounded new-file
   preview only where safe.
4. In `packages/cli/src/interactive.ts`, keep the event boundary intact but
   pass sufficient structured detail through existing TUI calls when needed.
   The current 720-character output preview and 520-character serialized
   details remain renderer input limits; session/agent history continues to own
   the raw result.
5. Render tabs and only the active detail viewport in `layout.ts`. Preserve
   terminal-control stripping, cell-width wrapping, ANSI reset correctness,
   and the one-column layout. Add an explicit empty-detail message instead of
   a blank inspector.
6. Expand TUI and CLI adaptation tests for tool-type view selection, exclusive
   expansion, tab navigation, offset clamping, error details, and safe handling
   of malformed/unknown tool inputs.

**Milestone evidence:** An `edit` entry exposes a bounded Diff preview; a
`bash` entry exposes its output and exit-state summary; no unavailable tab is
rendered.

## Milestone 3 — Transcript Follow Mode and Terminal Resilience

Make long-running sessions calm and navigable rather than permanently pinned
to the newest output.

1. Add layout/session state for follow-latest versus historical browsing and a
   count of unseen incoming events. Keep it owned by `@z-agent/tui`; it is not
   durable agent state.
2. When transcript focus moves away from the latest inspectable content,
   freeze its viewport. New assistant deltas and tool updates continue to
   mutate their existing entries, increment a compact unseen-event notice, and
   never steal focus. `End` resumes following and clears the notice.
3. Make `renderFrame` select transcript lines from the active viewport rather
   than always applying `slice(-bodyHeight)`. Ensure an inline inspector moves
   with its source tool row and is capped by the current width/height budget.
4. Refine header and footer priority at 110+, 80–109, and 80x24:
   - retain product and `RUNNING`/`READY` before cwd/model/session;
   - retain two editor rows and one hint row at 80x24;
   - cap inline detail viewport at 12, 8, and 6 rows respectively; and
   - never introduce horizontal scrolling.
5. Replace generic legacy strings added by `packages/cli/src/interactive.ts`
   (`[new]`, `[reset]`, `[compact]`, session loading) only if this slice also
   introduces typed boundary entries. Otherwise leave that product work out of
   scope rather than mixing it into visual refresh.
6. Add rendering and input regression tests for paused follow mode, `End`,
   streaming updates to a selected/expanded tool, confirmation priority,
   `NO_COLOR`, 80x24, and control-character sanitization.

**Milestone evidence:** While a real agent streams tool work, an operator can
inspect older tool details without forced scroll-to-bottom, then press `End` to
return to live output.

## Milestone 4 — Production Proof and Documentation Alignment

1. Update `packages/tui/README.md` and the relevant keyboard sections of
   `docs/tui-future-direction.md` to describe the one-column inline inspector
   and focus controls. Do not claim mouse support or a persistent wide pane.
2. Run only the tests changed for this work while iterating:

   ```bash
   npm --workspace @z-agent/tui test
   npm --workspace @z-agent/cli test -- interactive.test.ts
   ```

   Then run the repository-required full check after code changes:

   ```bash
   npm run check
   ```

3. In an interactive TTY with a configured model, run `npm run z-agent` in an
   isolated working directory and ask for a safe read/search action. Verify:
   - the agent emits a tool row;
   - `Tab`, `Up`/`Down`, `Enter`, and `Esc` perform the approved journey;
   - `Left`/`Right` switch views only when available; and
   - `NO_COLOR=1 npm run z-agent` retains textual state semantics.
   Repeat the frame proof at fixed 80x24 via the TUI tests and a practical
   terminal resize when available.
4. After fresh success through the entrypoint, create
   `docs/evidence/tui-inline-inspector-evidence.json` following the
   outcome-driven-development evidence contract. Include executed focused
   tests, the full check, manual TTY observation details, limitations, and
   evidence artifacts. Validate it with
   `check_outcome.py`; do not call the outcome verified if the configured
   model/TTY journey cannot be observed.

## Dependency and Risk Notes

- Existing line-diff repainting paints only changed rows. Detail expansion can
  change rows below it; tests must verify cleared stale rows at both expansion
  and collapse.
- The current output adapter intentionally truncates previews. The visual
  refresh must not bypass that limit or make rendering a second durable log.
- `Enter` and `Esc` already drive tool confirmation. Dispatch ordering must
  keep confirmation above transcript focus to prevent accidental approval or
  denial.
- The current parser has no `PgUp`/`PgDn`; adding escape sequences must retain
  correct behavior for partial chunks and pasted data.
- The plan deliberately keeps session-tree UI and extension/theme
  configuration outside this slice.
