# Inline Inspector Manual TTY Check

Observed on 2026-08-27 at 13:00 +08:00 through the real
`packages/cli/bin/z-agent.mjs` entrypoint in a pseudo-TTY.

1. Started Z Agent with an isolated working directory containing only
   `context.txt`.
2. Sent a constrained prompt requiring exactly one `read context.txt` tool
   invocation and forbidding file writes and shell commands.
3. Observed one `TOOL read {"path":"context.txt"}` lifecycle update from
   `RUNNING` to `DONE`, followed by an assistant response naming the file.
4. Sent `Tab`, `Enter`, `Right`, and `Esc`.
5. Observed transcript focus on the tool, inline `SUMMARY`, inline `OUTPUT`
   with the numbered file content, then restored editor focus.
6. Sent `/exit`; the TUI left the alternate screen and the process exited with
   status 0.

The check intentionally used read-only tool work. Write confirmation and
error-state interaction remain covered by focused automated TUI tests.
