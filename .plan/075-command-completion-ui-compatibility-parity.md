# PR75: Command completion UI, compatibility, and parity

> Status: **DONE**. Finished the visible and compatibility cleanup for
> event-driven command completion after the runtime notification path exists.

## Problem

The original PR72 scope includes more than the runtime wakeup itself. Users need to
see that a task is waiting on background commands, Stop must remain effective, tool
guidance should steer agents away from polling as the normal path, and Local /
container behavior should remain equivalent across pipes and PTYs.

Keeping these checks separate from PR73 avoids turning the inbox work into a broad
UI and compatibility sweep.

## Product Behavior

When a run is waiting on background command completion, the app should show a clear
waiting state using existing task/activity surfaces where practical. The user can
still stop the run. Completion status/output updates should come from runtime
events, not from periodic model polling.

Agents should understand the intended use:

- use foreground `exec_command` when the next action depends on the result;
- use `background: true` when independent work can proceed;
- use `wait_for_events` when independent work has run out; and
- reserve `poll_command` for deliberate output inspection.

Existing shell compatibility paths, test diagnostics sessions, Local/container
execution, and PTY output should keep their existing contracts unless explicitly
updated.

## Implementation Sequence

1. Add minimal IPC/preload/renderer plumbing for a task waiting-on-command state,
   reusing current task/activity events where possible.
2. Ensure Stop cancels pending waits, terminates owned background commands, removes
   listeners, and keeps late exits from restarting the run.
3. Update tool descriptions, system/tool guidance, and any internal prompts so
   polling is not presented as routine completion discovery.
4. Audit `run_shell_tool` compatibility and `test_diagnostics_tools.ts` so their
   session lifecycles are not accidentally changed by command completion events.
5. Verify Local and container command sessions both support foreground waiting,
   background completion, timeout cleanup, and cancellation.
6. Verify pipe and PTY sessions both surface final output and cleanup errors
   truthfully.
7. Add manual QA notes for waiting UI, Stop, background completion delivery, and
   retained output inspection.

## Acceptance and Verification

- The task UI clearly shows when the agent is waiting on background command
  completion.
- Stop remains available while waiting and prevents late command exits from
  restarting the agent.
- Tool guidance no longer encourages timer polling to discover normal background
  completion.
- `run_shell_tool` compatibility behavior is unchanged.
- `test_diagnostics_tools.ts` remains isolated from command completion events
  unless deliberately integrated.
- Local and container backends pass equivalent foreground/background/timeout/stop
  tests where the backend is available.
- Pipe and PTY sessions both deliver completion output without stream corruption.
- Production build and relevant focused tests pass, with manual UI verification
  recorded in the plan or PR notes.

## Implementation Notes

- Added a `command_wait` chat/task event emitted while the run loop is parked on
  owned background command completion.
- Mirrored the event through preload and rendered it in live chat as `Waiting for
  background command...` while keeping the normal Stop control available.
- Reused the task event stream in the Activity panel so running background tasks
  show `Waiting for background command` from live or replayed events.
- Added run-cancellation cleanup that invalidates the command-completion inbox and
  terminates any still-running background command sessions owned by that run.
- Updated `exec_command`, `wait_for_events`, and `poll_command` descriptions so
  normal completion discovery flows through runtime events instead of timer
  polling.
- Left `run_shell_tool` on its compatibility path and kept
  `test_diagnostics_tools.ts` isolated from command-completion events.

## Verification Notes

- `pnpm exec vitest run src/main/agent/tools/command_session_tools.test.ts`
  passed: 30 tests.
- `pnpm exec vitest run src/main/agent/env/local.test.ts
  src/main/agent/env/container.test.ts` passed: 70 tests, 40 environment-gated
  skips.
- `pnpm exec vitest run src/main/agent/tools/test_diagnostics_tools.test.ts`
  passed: 5 tests.
- `pnpm build` passed.
- `pnpm exec prettier --check src/main/agent/index.ts
  src/main/agent/tools/command_session_tools.ts
  src/main/agent/tools/command_session_tools.test.ts
  src/main/agent/tool-error-feedback.integration.test.ts src/preload/index.ts
  src/renderer/src/App.tsx src/renderer/src/components/tasks-section.tsx
  src/renderer/src/lib/timeline.ts` passed.
- `git diff --check` passed.
- SQLite-gated suites in this environment skipped
  `src/main/agent/tool-error-feedback.integration.test.ts` and
  `src/main/tasks/runner.test.ts`; the new assertions remain in place for
  environments where `better-sqlite3` loads.

Manual QA checklist for the app:

- Start a background command from a live interactive turn, then let the model run
  out of independent work; the transcript should show `Waiting for background
  command...` until the runtime event is delivered.
- Press Stop while that waiting marker is visible; the turn should stop, the
  command should be terminated, and no late completion should restart the run.
- Start equivalent background command work from a durable background task; the
  Activity panel row should show `Waiting for background command` while the task
  is parked.
- Use `poll_command` only after completion delivery to inspect retained output;
  output should remain bounded/pageable and truthful for pipe and PTY sessions.
