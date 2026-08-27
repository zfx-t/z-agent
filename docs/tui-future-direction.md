# TUI Future Direction

## Status

Baseline implemented against the approved TUI concept image. The remaining
items are incremental product work, not a replacement of the current renderer.
This is a product and implementation direction, not an ADR. It does not change
the core effect boundaries in ADR-0010.

## Purpose

Evolve the current clean-room terminal UI from a streaming transcript with
prompt, confirmation, and picker primitives into a coding-agent workspace that
is:

- observable while the agent is working;
- interruptible without losing the next instruction;
- recoverable through a navigable session history;
- extensible without coupling product behavior to the rendering layer.

The direction combines OpenCode's immediately usable workflow surface with Pi's
small, programmable runtime model. Z Agent should retain its stricter
path-jail and confirmation posture.

## Current Base

The shipped TUI already provides:

- alternate-screen, line-diff rendering;
- structured transcript and in-place tool lifecycle entries;
- multiline editor, prompt history, and bracketed-paste placeholders;
- live input while an agent run is active;
- streaming assistant text and foldable thinking;
- wide-terminal tool inspector, confirmation prompt, and session picker;
- terminal-width-aware wrapping and monochrome fallback.

The remaining work is session-tree navigation and extension/theme depth, not a
replacement of the rendering substrate.

## Product Principles

### Keep input available during long work

The input editor remains usable while the agent is streaming or executing
tools.

- `Enter` submits the current instruction to the active run through the Agent
  public queue API.
- `Shift+Enter` inserts a newline; the legacy `Alt+Enter` sequence remains
  accepted for terminals that emit it.
- `Ctrl+C` aborts the active run only; it must not discard the editor or
  session transcript.
- Bracketed pasted text and image attachments render as compact placeholders;
  the editor never expands copied content into the transcript surface.
- The footer uses neutral send/newline/interrupt hints. Internal queue
  semantics are not presented as product labels.

This maps directly onto the existing Agent queue API. The TUI requests those
public operations; it does not mutate loop state.

### Make agent work legible

Replace prefix-encoded transcript strings at the TUI boundary with a structured
view model. A transcript entry has a stable identity, category, lifecycle, and
expandable details.

Visible categories:

- user prompt;
- assistant response;
- thinking summary or collapsed thinking;
- tool invocation, progress, result, and failure;
- permission request and decision;
- compacted or restored session boundary;
- warning, cancellation, and recoverable error.

The primary transcript stays concise. Tool arguments, complete output, patches,
and failure diagnostics open in an inspector rather than forcing every detail
into the scrollback.

### Preserve history as a tree

Expose the existing JSONL session tree as a first-class session view:

- show the active branch and checkpoint labels;
- select an earlier node and continue from it;
- distinguish a restored branch from the live branch;
- keep export and sharing outside the live transcript.

Session traversal changes agent context through the established CLI/session
boundary. Rendering the tree is not durable storage and is not an agent-core
effect.

### Treat safety as a workflow, not an interruption

Confirmation uses an explicit modal that includes tool name, target scope,
command or patch summary, and the available decision.

- Allow once, allow for this session, and deny remain keyboard-first.
- Denial supplies a concise result to the agent and leaves the user at the
  live transcript.
- The permission UI never hides an active tool timeline or the draft editor.

### Let the product grow through stable hooks

Commands, status segments, transcript renderers, inspector panes, and optional
key bindings should have explicit extension points. Extensions may contribute
presentation and CLI behavior, but must not create new effect paths in
`@z-agent/agent`.

## Proposed Workspace

```text
+----------------------------------------------------------------------------+
| Z AGENT | cwd | model | run state | session branch                |
+----------------------------------------------------------------------------+
| Transcript                                                               |
|  YOU     Implement the parser change                                      |
|  AI      I will inspect the current parser and tests.                     |
|  TOOL    grep  running                                      [details]     |
|  DONE    grep  12 matches, 18 ms                            [details]     |
|  AI      The parser already rejects ...                                   |
|                                                                            |
|                                                    Inspector (when opened)|
|                                                    args / output / diff    |
+----------------------------------------------------------------------------+
| > Editor remains active during a run                                      |
|   [Pasted text - ...] [Image - ...]  Enter send  Ctrl+C interrupt          |
+----------------------------------------------------------------------------+
```

The full-width transcript remains the default for narrow terminals. The latest
tool inspector appears beside it on wide terminals and is omitted below the
wide breakpoint. It never reduces the editor below a usable multiline height.

## Visual and Interaction Specification

The UI is terminal-native, dense, and deliberately plain. It is not a web
dashboard rendered inside a terminal.

### Semantic terminal tokens

Use the terminal's available color depth, with a monochrome fallback. Color
reinforces text labels; it never carries state by itself.

| Token | Default intent | Terminal treatment |
| --- | --- | --- |
| background | quiet working surface | terminal default or near-black |
| foreground | primary transcript text | high-contrast light neutral |
| muted | timestamps, hints, collapsed context | readable gray, never primary copy |
| focus | editor cursor, selected picker row, active pane | cyan plus marker or inverse state |
| running | active model or tool | cyan plus `RUNNING` text |
| success | completed tool or permission allowed | green plus `DONE` or `ALLOWED` text |
| warning | confirmation, cancellation, recoverable risk | amber plus explicit status text |
| error | failed tool or agent error | red plus `FAIL` or `ERROR` text |

The existing 256-color palette is a suitable baseline. Theme configuration must
map semantic tokens rather than hard-code color values in transcript renderers.

### Layout rules

- Header: one stable line for product, cwd, model, run state, and active branch.
  Truncate lower-priority fields before the run state.
- Transcript: the primary scrolling region. Entries wrap by terminal cell width
  and preserve their category label on the first line.
- Inspector: at 110 columns or wider it receives about 36% of the width and a
  minimum of 38 columns. Below that width the transcript uses the full width.
- Editor: fixed at the bottom, with no line-number gutter, at least two input
  rows, display-only paste placeholders, and one hint row.
  Its height does not shrink while streaming.
- Confirmation: an explicit warning row above the editor. It leaves the last
  relevant tool event and current draft visible.
- Minimum supported size: 80x24. Below this, drop secondary header fields,
  hide the inspector, and reduce hints before reducing the editor.

### Interaction rules

- The active editor cursor or modal/picker selection is always visible.
- Every command has a direct key path or a command-palette path; mouse support,
  if added, is supplementary.
- Long operations show category, lifecycle, and elapsed time. Completion
  replaces the running state in place to avoid transcript jitter.
- Animation is limited to a low-frequency textual spinner or elapsed-time
  update. Respect an environment-level reduced-motion preference where
  available.
- Thinking, raw tool output, and diffs are progressive disclosure. The user can
  inspect them without losing the live transcript position.

## Delivery Sequence

### R1: Structured TUI state (implemented)

Introduce typed transcript and status entries in `@z-agent/tui`; adapt the CLI
event subscriber to append structured events instead of formatted strings.

Acceptance:

- rendering does not parse `tool:start:` or similar text prefixes;
- a tool entry can update from running to completed or failed;
- existing plain transcript lines remain representable;
- no change to `streamAssistant` or `tool.execute` effect boundaries.

### R2: Live input during a run (implemented)

Allow the editor to submit during an active run and wire it to the public
`Agent.steer` API. The queue distinction remains an internal runtime concern.

Acceptance:

- user text is neither dropped nor mistaken for a new `prompt` call;
- the editor remains visible while the run is active;
- abort leaves the editor and transcript intact.

### R3: Inspector and permission context (baseline implemented)

Add a detail inspector for tool input/output, diffs, errors, and confirmation
context. Keep the transcript compact and preserve copyable raw output.

Acceptance:

- the active transcript position remains stable while an inspector opens;
- confirmation decisions remain accessible without a mouse;
- narrow terminals preserve a full-width transcript and live editor.

### R4: Session tree and checkpoints

Upgrade the session picker into a branch-aware history view. Support restoring
an earlier node and creating a new active branch from it.

Acceptance:

- restoring a branch clearly identifies the source checkpoint;
- session loading never silently merges unrelated branches;
- malformed history produces a local error state rather than a corrupted
  transcript.

### R5: Commands, status, and extension surface

Add a discoverable command palette, configurable key bindings, status segments,
and stable rendering hooks for extensions.

Acceptance:

- all commands are available from the keyboard;
- missing or failed extensions degrade locally;
- extension-provided presentation cannot bypass trust, jail, or confirmation.

### R6: Themes, accessibility, and terminal resilience (baseline implemented)

Add semantic theme tokens and explicit reduced-color support. Validate common
terminal widths and copy/paste behavior before adding decorative motion.

Acceptance:

- monochrome mode communicates state without color alone;
- focus, selection, and modal states are visible at low color depth;
- 80x24 remains usable without horizontal scrolling;
- wrapping preserves full-width Unicode correctness.

## Implementation Boundaries

| Concern | Owner |
| --- | --- |
| Agent queues, messages, tool lifecycle | `@z-agent/agent` |
| Rendering state, editor, overlays, terminal input | `@z-agent/tui` |
| Event adaptation, commands, sessions, extensions, trust | `@z-agent/cli` |
| Durable session and operation persistence | `@z-agent/harness` |

The CLI adapts agent events into TUI state. The TUI does not import provider
code, execute tools, or write durable session state.

## Explicit Non-goals

- importing `pi-tui`, Ink, or a native terminal renderer;
- turning the terminal into a mouse-first dashboard;
- introducing durable state into the agent core;
- duplicating the tool execution pipeline inside the TUI;
- making arbitrary extensions trusted by default.

## Validation Strategy

- Unit-test transcript-state transitions, editor modes, inspector focus, and
  terminal-width layout in `@z-agent/tui`.
- Unit-test CLI event adaptation and live-input dispatch in `@z-agent/cli`.
- Keep agent queue and lifecycle tests in `@z-agent/agent`.
- Add scripted terminal smoke cases for: streaming tools, denied confirmation,
  live input, abort, session restore, and 80x24 rendering.
