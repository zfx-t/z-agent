# @z-agent/tui

Clean-room terminal UI for the z-agent coding CLI. No pi-tui, no Ink, no native addons.

Assistant transcript text is GitHub-Flavored Markdown: headings, emphasis, lists,
fenced code, links, and tables. User input, thinking, and tool rows stay literal.
`NO_COLOR` keeps the same markers without SGR. Print mode is not Markdown-aware.

The workspace uses structured transcript entries, in-place tool lifecycle
updates, a keyboard-selected inline tool inspector, and an editor that remains
active during a run. Bracketed pasted text and image attachments render as
compact placeholders instead of expanding copied content in the editor.

Transcript rows carry a fixed label gutter (`YOU`, `AI`, `THINK`, `TOOL`,
`WARN`, `ERROR`, `INFO`); a blank line separates turns. Tool rows show a
semantic target summary (`$ command`, path, `/pattern/ in dir`), a right-aligned
state marker with elapsed time (`⠋ 1.2s` running, `✓ DONE 480ms`, `✗ FAIL`),
and a dim `⎿` output preview line. While the model works, the header shows
`RUNNING <spinner> <elapsed>` and idle gaps render a `waiting for model` row;
the streaming assistant ends with a `▌` cursor. Input steered into an active
run is tagged `(queued)`. `Z_AGENT_MOTION=off` swaps the spinner for static
labels and slows the ticker.

Terminal-width handling counts East-Asian Ambiguous code points as 2 cells when
`Z_AGENT_AMBIGUOUS=double`, `RUNEWIDTH_EASTASIAN`, or a CJK locale is detected —
miscounting them makes painted rows overflow and corrupts absolute positioning.
Under that mode the chrome glyph set falls back to ASCII; force either set with
`Z_AGENT_GLYPHS=unicode|ascii`. Every painted line is also clipped to the
terminal width as a last-resort guard.

The editor keeps a real terminal cursor (hidden during transcript focus,
pickers, and confirms) inside a `╭─╮` box that dims when unfocused, plus a dim
placeholder hint when empty. Word motion follows the usual readline chords:
`Ctrl+Left`/`Ctrl+Right` (or `Alt+Left`/`Alt+Right`) jump words, `Ctrl+Delete`
deletes a word forward, `Alt+Backspace` and `Ctrl+W` delete backward, and
`Ctrl+K` kills to end of line.

Keys: `Enter` sends, `Shift+Enter` inserts a newline, `Ctrl+C` interrupts an
active run, and `Ctrl+T` toggles the latest thinking entry. Outside slash
completion, `Tab` moves between the editor and transcript and `PageUp`/`PageDown`
scroll the transcript from either focus; the mouse wheel also scrolls the
transcript in any focus (and moves the selection inside pickers) — reporting
is enabled via SGR 1006/1000 and can be disabled with `Z_AGENT_MOUSE=off`.
Transcript focus uses `Up`/`Down` to
select tools, `Enter` to expand details, `Left`/`Right` to change available
views, `g`/`G` for top/latest, and `Esc` to return to the editor. Tool details
stay in the single-column transcript at every supported width.

When the editor's first token starts with `/`, a fixed-height popup combines
built-in commands and skill names. Candidates rank by exact, case-insensitive
prefix, substring, then ordered fuzzy character match. `Tab` accepts the best
candidate and cycles forward on repeated presses, `Shift+Tab` cycles backward,
`Up`/`Down` move directly through candidates, and `Esc` cancels. Only the
command token is replaced, so arguments and
cursor-relative text stay intact. Selecting a candidate never activates a skill
or calls the model.

Slash commands submitted during a provider run remain pending in FIFO order and
are processed at safe turn boundaries. The running request keeps its original
immutable context snapshot; a queued `/reload` applies before later queued skill
commands.
