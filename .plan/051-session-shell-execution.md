# PR51: Session-oriented shell execution

> Status: **DONE**. Depends on `049` effect metadata. Reuses the existing
> `node-pty`/TerminalService foundation. No DB migration in the first slice.

## Context

`run_shell_tool` starts one non-interactive shell command, closes stdin, buffers a
combined stdout/stderr result, and blocks until exit or a ten-minute timeout. It
cannot operate a watcher, development server, REPL, interactive installer, or a
command that needs incremental input. Large output is silently capped after the
first megabyte.

The app already ships `node-pty` and manages user terminal sessions, but agent
commands need stricter workspace, approval, ownership, output, and cleanup rules
than the visible terminal drawer.

## Goal

Replace the one-shot-only experience with a bounded command-session protocol:
quick commands still return immediately, while a running command yields a
session id that the agent can poll, write to, interrupt, or terminate.

## Tool surface

### `exec_command`

- Inputs: command, optional workspace-relative cwd, timeout, yield duration,
  output cap, and `tty` flag.
- Runs approval before spawn. Resolves cwd inside the workspace.
- Waits up to the yield duration; returns completed structured output or
  `{ status:"running", sessionId, recentOutput, cursor }`.

### `write_stdin`

- Inputs: session id, text/control bytes, optional EOF, optional yield duration.
- Session ownership must match conversation + turn/task context.
- Returns output since the supplied/current cursor and current status.

### `poll_command` and `terminate_command`

- Poll returns only new bounded output plus a monotonic cursor, total byte count,
  truncation/dropped-byte metadata, duration, and terminal status.
- Terminate sends graceful interrupt first, then kills the whole process tree
  after a short deadline. Stop/app quit use the same cleanup path.

## Runtime design

- Extract a reusable PTY/process-session core from `TerminalService`; do not let
  agent sessions appear as or control user terminal tabs.
- Key sessions by random id and bind them to conversation, task/turn, workspace,
  environment backend, creation time, and abort controller.
- Maintain a bounded ring buffer rather than unbounded transcript output.
- Non-TTY commands preserve stdout/stderr as separate ordered chunks where the
  backend permits it; PTY output is one terminal stream by definition.
- Local uses `node-pty` for TTY and detached process groups for pipe mode.
  Container adds an equivalent exec-session abstraction rather than leaking a
  host `docker exec` PID as the durable identity.
- Default idle/lifetime limits reap abandoned sessions. v1 sessions are runtime
  only and are cancelled on app quit; durable crash-resume is deferred.

## Compatibility

- Keep `run_shell_tool` as a compatibility wrapper over `exec_command` that waits
  for completion within its existing timeout. New prompts/tool selection prefer
  the session tools.
- Return structured status metadata while rendering concise text for current
  OpenAI-compatible tool-result messages.

## Verification

- Immediate command, delayed command, watcher/server, stdin-driven program,
  Ctrl-C, EOF, timeout, explicit terminate, Stop, and app disposal.
- Cursor polling has no duplicated/missing chunks; ring-buffer overflow reports
  exact dropped-byte metadata.
- Session ids cannot cross conversations/workspaces.
- Whole process trees die on termination on macOS/Linux/Windows; container child
  cleanup is verified independently.
- Output remains UTF-8 safe across arbitrary chunk boundaries and PTY resize.
- Existing shell approval and compatibility tests remain valid.

## Out of scope

- Durable command sessions across app restart.
- Exposing user terminal drawer sessions to the model.
- Changing Local shell security posture; `052` owns confinement/policy.
