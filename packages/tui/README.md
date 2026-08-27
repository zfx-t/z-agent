# @z-agent/tui

Clean-room terminal UI for the z-agent coding CLI. No pi-tui, no Ink, no native addons.

The workspace uses structured transcript entries, in-place tool lifecycle
updates, a wide-terminal tool inspector, and an editor that remains active
during a run. Bracketed pasted text and image attachments render as compact
placeholders instead of expanding copied content in the editor.

Keys: `Enter` sends, `Shift+Enter` inserts a newline, `Ctrl+C` interrupts an
active run, and `Ctrl+T` toggles the latest thinking entry. The session and
command pickers remain keyboard-only. At widths below 110 columns the inspector
is omitted and the transcript uses the full terminal width.
