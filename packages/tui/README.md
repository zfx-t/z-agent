# @z-agent/tui

Clean-room terminal UI for the z-agent coding CLI. No pi-tui, no Ink, no native addons.

The workspace uses structured transcript entries, in-place tool lifecycle
updates, a keyboard-selected inline tool inspector, and an editor that remains
active during a run. Bracketed pasted text and image attachments render as
compact placeholders instead of expanding copied content in the editor.

Keys: `Enter` sends, `Shift+Enter` inserts a newline, `Ctrl+C` interrupts an
active run, and `Ctrl+T` toggles the latest thinking entry. `Tab` moves between
the editor and transcript; transcript focus uses `Up`/`Down` to select tools,
`Enter` to expand details, `Left`/`Right` to change available views, and `Esc`
to return to the editor. The session and command pickers remain keyboard-only.
Tool details stay in the single-column transcript at every supported width.
