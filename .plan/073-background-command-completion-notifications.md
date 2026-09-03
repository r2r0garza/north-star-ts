# PR73: Background command completion notifications

> Status: **IMPLEMENTED**. Finish the event-driven half of PR72 by notifying the
> owning agent run when a background `exec_command` settles, without requiring
> model-driven polling or a new user message.

## Problem

PR72 introduced the command-session layer split:

- foreground `exec_command` waits for a settled backend exit by default;
- `background: true` returns a running session immediately; and
- each session now has a single settled primitive that fires from `handle.onExit`.

That is necessary but incomplete. A background command can still finish silently
unless the agent explicitly calls `poll_command`. The intended product behavior is
that the runtime observes the exit event and delivers a completion back to the
same agent run at a safe point.

## Product Behavior

When an agent starts `exec_command` with `background: true`:

1. The original tool call returns promptly with a session ID and launch metadata.
2. The command-session layer registers the session with a run-scoped completion
   inbox before process output or exit can be lost.
3. When the process settles, the inbox receives exactly one completion event with
   status, exit code/signal, timeout state, cleanup errors, duration, cursor data,
   and bounded output.
4. If the agent is still doing other work, the completion is drained before the
   next eligible model request.
5. If the agent would otherwise finish while owned background commands remain,
   the run enters a waiting state instead of finalizing.
6. When the command completes, the waiting run wakes and gives the model the
   completion result.

No routine polling should be required for normal completion discovery. `poll_command`
remains available only for intentional inspection of retained output.

## Design Constraints

- Scope every inbox to conversation ID, workspace, and active run identity.
- Never deliver a completion to a different conversation, workspace, or superseded
  run.
- Record the original background tool result before any completion notification.
- Do not attach a second provider tool response to the original `exec_command`
  call. Use an explicit runtime-event representation or a `wait_for_events` tool
  result.
- Mark events consumed only after they are incorporated into recorded model
  context, so model transport retries do not duplicate delivery.
- Treat command output as untrusted tool data.
- Batch simultaneous completions within the existing model output budget and
  retain overflow for later delivery.
- Stop/cancellation must terminate owned background commands and invalidate
  future wakeups. Late process exits may update retained session state but must
  not restart a stopped run.

## Implementation Sequence

1. Add a main-process `CommandCompletionInbox` owned by the built-in agent runtime.
   It should support registering background sessions, enqueueing settled events,
   draining queued events, waiting for matching events, cancellation, and cleanup.
2. Add a model-facing `wait_for_events` tool. It should wait for already-queued or
   future command completions, optionally scoped to session IDs, and return a clear
   result when there are no matching pending commands/events.
3. Wire `exec_command background=true` to register sessions with the current run
   inbox and enqueue exactly one settled completion from the session exit path.
4. Integrate draining into `src/main/agent/index.ts` at safe model-request
   boundaries after ordinary tool results have been persisted.
5. Change tool-free finalization while owned background commands remain: put the
   run into an explicit waiting state, keep Stop available, and resume only from
   an inbox wakeup or user interruption.
6. Add UI/status plumbing only as needed to show that the task is waiting on
   background command completion.

## Acceptance and Verification

- Background launch returns promptly with `status: "running"` and a `sessionId`.
- A background command that exits while the agent is doing independent work is
  delivered once before the next model request.
- A background command that exits after the agent runs out of work wakes the idle
  run without periodic model calls or a new user message.
- Immediate exits cannot race registration and get lost.
- Multiple simultaneous exits are batched without losing overflow.
- `wait_for_events` returns queued completions immediately and does not periodically
  return `"still running"`.
- Forged session IDs and other conversations cannot observe or consume events.
- Stop while waiting terminates owned commands, releases inbox listeners, and late
  exits do not restart the agent.
- Focused tests cover the inbox, `wait_for_events`, run-loop wakeup/finalization,
  and duplicate/lost event races.

## Implementation Notes

- Added a run-scoped `CommandCompletionInbox` keyed by conversation ID, workspace,
  and run ID.
- Added `wait_for_events` for explicit event waits without routine polling.
- Wired background `exec_command` sessions to register before exit handlers and
  enqueue bounded completion results from the settled path.
- Drained completions into persisted runtime context before later model requests.
- Changed tool-free finalization to wait while owned background commands remain,
  then wake the run with the completion event.

## Verification Run

- `pnpm vitest run src/main/agent/tools/command_session_tools.test.ts src/main/agent/tool-error-feedback.integration.test.ts src/main/agent/agents/tool-categories.test.ts src/main/agent/tool-availability.test.ts`
- `pnpm exec tsc --noEmit`
- `pnpm test`

## Manual Test Scenario

Ask the agent to launch a background command and continue independent work:

```text
Start this in the background, then inspect two project files while it runs:
node -e "setTimeout(() => { console.log('background done') }, 3000)"
```

Expected behavior after PR73: the agent should inspect the files, then receive the
command completion automatically when the process exits. It should not call
`poll_command` on a timer just to discover completion.
