# TUI Visual Refresh Design

**Date:** 2026-08-27
**Status:** Implemented; real-TTY validation recorded on 2026-08-27

## Goal

Refresh `@z-agent/tui` from a functional structured terminal interface into a
calm, legible coding-agent console. The default experience is a single-column
conversation. Tool detail is progressive disclosure inside that conversation,
not a persistent wide-screen side inspector.

The work preserves terminal-native rendering, keyboard-first interaction,
alternate-screen line-diff painting, live editing during a run, and the agent
core effect boundaries.

## Design Direction

The approved direction is **Quiet Console + Inline Inspector**.

- Quiet Console provides a restrained header, chronological transcript,
  narrow timestamp gutter, semantic labels, and a fixed composer.
- The existing wide Inspector becomes an inline detail section below the
  selected tool entry.
- The interface remains one column at every supported width. Width affects
  metadata and detail height, not the information architecture.
- The visual language is dense but calm: no rounded cards, gradients, web
  dashboard chrome, mouse-first controls, or decorative motion.

## Layout

```text
Z AGENT  cwd  model  RUNNING|READY  session
------------------------------------------------
09:14:02  YOU    Request
09:14:03  AI     Response
09:14:04  TOOL   read parser.ts          DONE
09:14:05  TOOL   edit parser.ts          DONE  <selected>
                  SUMMARY  OUTPUT  DIFF
                  tool metadata and bounded preview
09:14:07  AI     Result summary

CONFIRM action ... [Enter] once [A] session [Esc] deny
------------------------------------------------
> Composer remains editable
Tab conversation  Up/Down select  Enter inspect  Esc editor
```

### Header

One stable row in priority order:

1. `Z AGENT`
2. current working directory
3. model
4. run state (`RUNNING` or `READY`)
5. active session branch

When space is limited, truncate or omit from the end of that order, except
that product name and run state always remain visible.

### Transcript

Each entry has a narrow time gutter, a fixed-width kind label, and a wrapping
body. The primary kinds are `YOU`, `AI`, `THINK`, `TOOL`, `WARN`, `ERROR`, and
session boundaries. Assistant prose stays in the terminal foreground color;
only labels and state markers are semantic-colored.

Tool entries are concise in their collapsed state:

```text
TOOL  edit packages/agent/src/parser.ts
      ✓ DONE · 1 file · +32 −6 · 3 ms
```

Tool arguments, complete output, diffs, failure diagnostics, and other raw
details are not repeated in the collapsed row.

### Composer

The composer remains fixed at the bottom while the agent runs. It has a thin
focus edge, a single `>` prompt marker, no line-number gutter, compact
display-only attachment placeholders, and one concise hint row. It remains at
least two input rows at the 80x24 minimum size.

## Keyboard Interaction

The editor is the default focus target. No mouse interaction is added.

| Context | Key | Behaviour |
| --- | --- | --- |
| editor | `Tab` | Move focus to the transcript. |
| transcript | `Up` / `Down` | Select the previous or next inspectable tool entry. |
| transcript | `Enter` | Toggle details for the selected entry. Opening a new entry closes the previously expanded entry. |
| expanded details | `Left` / `Right` | Change between available `SUMMARY`, `OUTPUT`, and `DIFF` views. |
| expanded details | `PgUp` / `PgDn` | Scroll bounded detail content. |
| expanded details | `Home` / `End` | Jump to the start or end of bounded detail content. |
| transcript or details | `Esc` | Return focus to the editor without discarding the expanded section. |
| active run | `Ctrl+C` | Request run abort without clearing the editor or transcript. |
| any confirmation | `Enter`, `A`, `Esc` | Confirmation consumes these keys before transcript controls. |

`Tab` and `Esc` provide the focus boundary that prevents transcript navigation
from conflicting with existing editor history and cursor controls.

## Inline Inspector

Only one tool inspector may be expanded at a time. It is rendered immediately
after the selected transcript row and scrolls with the transcript.

The inspector uses tabs only for views that exist for that tool:

| Tool kind | Default view | Optional views |
| --- | --- | --- |
| `read`, `grep`, `find` | Summary | Output |
| `edit`, `write` | Summary | Diff, Output |
| `bash` | Summary | Output |
| error result | Summary | Output, failure detail |

Summary always opens first and shows tool name, target, operation or command,
duration, result state, and a short preview. Output and diff content use a
bounded internal viewport. Full raw content remains represented by the active
session transcript/session data; the renderer does not create durable state.

## Visual Tokens

Use semantic theme tokens. Renderers must consume token names rather than raw
palette values.

| Token | Intent | Midnight baseline |
| --- | --- | --- |
| `foreground` | assistant prose and primary text | `#E7EDF4` |
| `muted` | timestamps, hints, collapsed context | `#8796A6` |
| `focus` | selected row, cursor edge, active run | `#58D6FF` |
| `info` | informational tool label | `#9ABBD9` |
| `success` | completed work | `#8FE374` |
| `warning` | confirmation, cancellation, recoverable risk | `#F0C75E` |
| `error` | failed operation | `#FF7B7B` |
| `surface` | selected row and expanded inspector | `#101720` |
| `border` | dividers and structural rules | `#2A3948` |

Color reinforces text and symbols; it never carries state alone. State is
always additionally encoded with a label or glyph such as `◌ RUNNING`,
`✓ DONE`, `! WARN`, or `✕ FAIL`. Under `NO_COLOR` or low-color support, the
same labels, focus rail, and inverse/surface treatment remain visible.

## Streaming, Scroll, and Safety States

- Assistant deltas and tool lifecycle rows update in place. They do not append
  duplicate summary lines or animate layout changes.
- The only permitted motion is a low-frequency textual running marker or
  elapsed-time update. Reduced-motion environments use static status text.
- While following live output, the transcript stays anchored to the latest
  content. Once the user navigates away from the latest item, auto-follow
  pauses and a `↓ N new events · End follow latest` notice appears.
- Confirmation is a warning shelf directly above the composer. It preserves
  the relevant tool record and the user draft, takes key priority, and does
  not become a full-screen modal.
- Error rows state the failed action, a concise reason, and a recovery path
  when one exists. Abort and denial leave the transcript and draft intact.
- An empty transcript shows `Describe a task, paste context, or /help`.
- Restored or compacted sessions are explicit boundary rows and never merge
  silently with normal conversation entries.

## Terminal Sizes

The supported minimum remains 80 columns by 24 rows.

| Terminal width | Header | Inline inspector |
| --- | --- | --- |
| 110+ columns | all fields where they fit | maximum about 12 visible detail rows |
| 80–109 columns | progressively omit cwd/model before run state | maximum about 8 visible detail rows |
| 80x24 | product, run state, branch; compact timestamps | maximum 6 detail rows; composer still has 2 rows |

Below the supported minimum, preserve the editor and status text first; omit
secondary metadata and detail previews before truncating primary content.

## Implementation Boundaries

`@z-agent/tui` owns focus, selection, rendering state, layout, terminal input,
and bounded detail scrolling. `@z-agent/cli` maps agent events to tool summary,
output, and diff view data. `@z-agent/agent` remains unchanged: it owns queues,
messages, streaming, and tool execution; no new agent-core effect path is
introduced.

Likely touchpoints:

- `packages/tui/src/model.ts`: add inspector view, selected entry, transcript
  focus, follow state, and detail-scroll view state.
- `packages/tui/src/session.ts`: focus transitions and priority-aware key
  dispatch.
- `packages/tui/src/keys.ts`: page navigation keys if not already parsed.
- `packages/tui/src/layout.ts`: one-column entry renderer and inline inspector
  renderer; remove wide split-body rendering as the default detail mechanism.
- `packages/cli/src/interactive.ts`: provide compact per-tool view data without
  changing agent effect boundaries.
- `packages/tui/test/tui.test.ts`: focused navigation, exclusive expansion,
  confirmation priority, stream-follow behavior, monochrome rendering, and
  80x24 layout coverage.

## Acceptance Criteria

1. The default transcript is a single readable column at all supported widths.
2. A keyboard user can focus a tool, open/close its detail inline, switch
   available detail views, and return to the editor without a mouse.
3. Only one tool is expanded at a time; long output is bounded and scrollable.
4. The editor remains usable during assistant streaming and tool execution.
5. `RUNNING`, `DONE`, `WARN`, and `FAIL` remain distinguishable when color is
   disabled.
6. Confirmation always wins over inspector keys and preserves editor state.
7. At 80x24 there is no horizontal scroll, at least two composer rows remain,
   and secondary metadata is reduced before primary content.
8. Tool lifecycle updates occur in place without duplicate transcript entries
   or distracting layout jitter.
9. No change creates an effect path outside `streamAssistant` or
   `tool.execute` in `@z-agent/agent`.

## Non-goals

- mouse support;
- a persistent right-hand tool inspector;
- a web-dashboard or card-based terminal appearance;
- arbitrary theme marketplace/configuration in this visual-refresh slice;
- changes to session durability, tool execution, or provider behavior.

## Validation Plan

- Add rendering tests for collapsed and expanded tool rows, each available
  inspector view, semantic monochrome fallbacks, and width/height constraints.
- Add session input tests for `Tab`, transcript selection, exclusive
  expansion, tab switching, `Esc`, and confirmation key priority.
- Add scripted terminal cases for streaming with a paused follow position,
  live editor submission, confirmation, denial, abort, and an 80x24 frame.
- Run `npm run check` after implementation changes. Run only TUI tests added
  or changed for this slice unless broader testing is requested.
