# PR72: Event-driven command completion

> Status: **PLANNED — NEXT UP**. Support foreground waiting and background
> execution through `exec_command`, and deliver command completion to the agent
> without repeated model-driven polling.

## Problem

Today `exec_command` waits briefly, then returns a session ID for a command that is
still running. The agent must call `poll_command` or `write_stdin` to discover that
the command finished. Repeated checks add model calls, transcript noise, and delay
between process completion and useful follow-up work.

The runtime already knows when a process exits. It should use that event to return
a waiting tool result or notify the owning agent loop.

## Agreed behavior

One execution tool supports both modes:

| Argument | Tool behavior | Agent behavior |
| --- | --- | --- |
| `background: false` (default) | Remains pending until the command finishes, times out, or is cancelled; returns bounded output and exit details. | Waits without additional model calls when the next action depends on the result. |
| `background: true` | Returns a session ID after successful launch, without waiting for a yield interval; queues completion when the command settles. | Continues independent work and receives the result automatically. |

Approval and launch can still take time in either mode. “Background” does not skip
approval, detach the process from its owner, or create a new agent/task conversation.

If independent work runs out, the agent calls `wait_for_events`, optionally scoped
to command session IDs. The call waits for a relevant completion or cancellation;
it does not return periodically with “still running.” Already-queued completions
return immediately. With no matching pending commands or events, return a clear
result rather than waiting forever.

Keep `timeout_ms` as the command lifetime limit in both modes. Waiting does not reset
it. Preserve current limits initially (30 seconds by default, 10 minutes maximum)
and explain that longer commands need an explicit timeout. `background` replaces
the model-facing yield decision: remove/deprecate `yield_ms` on `exec_command`,
without letting it silently turn a foreground call into background execution.
Historical transcripts remain readable; audit callers and tests for old assumptions.

## Existing implementation seams

- `src/main/agent/tools/command_session_tools.ts` owns command sessions, bounded
  output with cursors, timeouts, ownership checks, and `handle.onExit` callbacks.
  `settleSession` currently records the exit and schedules deletion after five
  minutes; it does not notify the agent loop.
- `src/main/agent/env/types.ts` exposes `CommandSessionHandle` through the
  Environment abstraction. Reuse the Local/container execution implementations.
- `src/main/agent/index.ts` runs successive model/tool rounds and currently ends
  the turn on a response without tool calls. It needs an event inbox and a waiting
  lifecycle so pending background results do not require a new user message.
- Tool registration, availability, capability categories, and batch scheduling
  must recognize the wait tool and preserve the existing execution policy.
- `test_diagnostics_tools.ts` has its own command-like session lifecycle. Audit
  shared consumers and avoid accidentally changing their contracts in this work.

These are starting points, not a claim that resumption or durable completion
delivery already exists.

## Runtime design

### Foreground execution

Await a settled process result through the existing exit signal, with cancellable
listener cleanup. Do not implement waiting as a timer loop or repeated model calls.
Return only after exit details and final buffered output are available. Timeout and
termination requests must not be mistaken for confirmed process exit.

Foreground commands return their result once through their original tool call;
they do not also generate an unsolicited completion event.

### Background completion inbox

Give each active agent run an inbox scoped to its conversation, workspace, and run
identity. Register a background command with its owner before completion can be
lost, including commands that exit immediately after launch. Use a stable completion
ID to deduplicate delivery.

On settled exit, enqueue a structured event containing command/session identity,
terminal status, exit code or signal, duration, bounded output, and output cursor /
truncation information. Nonzero exits, timeout, and cleanup failures must remain
visible. Treat command output as untrusted tool data, never as system instructions.

Persist the delivered event in the transcript using a representation supported by
the provider adapters. Do not invent an orphan tool response or attach a second
response to the original `exec_command` call. Use the outstanding wait tool response
when appropriate; otherwise adapt an explicitly identified runtime notification.

The original background call must be recorded before its completion notification.
Drain queued events at safe model-request boundaries, after outstanding tool results
have been recorded. Never inject into a request already streaming or start a second
model request concurrently for the same conversation. Batch simultaneous completions
within an output budget, retaining overflow for subsequent delivery.

Mark events consumed only when incorporated into the recorded model context. A
model transport retry must reuse that context without generating a duplicate event.
Manual output reads and wait results must coordinate cursors so results are neither
silently skipped nor repeatedly injected.

### Waiting and turn completion

`wait_for_events` awaits the same inbox used for automatic delivery. A queued event
must have one consumer even when the agent reaches a wait as a process exits.
Register/check atomically enough to avoid a lost wake-up. Stop cancels pending waits
and removes listeners.

While finite background commands owned by the active run remain unresolved, a
tool-free assistant response must not silently retire the run and strand their
results. Keep the run in an explicit waiting state, deliver completions, and let the
agent review them before finalizing. A waiting run uses no model calls until there
is an event. User input follows the existing conversation serialization/interrupt
policy; it must not create concurrent loops or consume another run's events.

User Stop/cancellation invalidates automatic wake-ups for that run and terminates
its commands through existing cleanup. A late exit may update recorded status but
must never restart the stopped agent. Also release inboxes/listeners on errors,
conversation deletion, and shutdown.

### Output lifetime and UI

Replace unconditional five-minute deletion for undelivered completions with bounded
retention that preserves the result until consumption or explicit owner cleanup.
Keep byte caps and make dropped/truncated output explicit; never imply all output
is retained. Session cursors remain available for intentional inspection of retained
output. Settle/listener handling must work for both pipes and PTYs.

Show that the agent is waiting on commands and keep Stop available. Background
command status/output updates must not depend on model polling. Reuse existing UI
events where practical; any new renderer capability goes through main IPC and
`window.cowork` in preload.

## Scope and compatibility

- Deliver this for North Star's built-in agent loop, including callers using that
  shared loop. External CLI providers keep their own execution lifecycle; this does
  not depend on the planned `045` MCP bridge.
- Keep `poll_command` available for explicit status/output inspection and retain
  `write_stdin` / `terminate_command`. Update guidance so polling is not the normal
  completion-discovery mechanism. Waiting must be available to agents allowed to
  start background commands without widening their execution permissions.
- Preserve workspace confinement, approval decisions, output limits, process-tree
  cleanup, and Local/container behavior. Background launch must not imply that
  conflicting workspace operations are safe to run concurrently.
- v1 covers finite commands within the current app/run lifetime. Do not promise
  process survival or autonomous continuation after app restart. Interrupted runs
  must not replay a command merely because its completion was not delivered.
- Interactive commands may use background execution plus stdin/inspection. Generic
  “ready” / “needs input” detection, detached development servers, and a general
  cross-task event bus are follow-ups. Do not keep the agent waiting forever on a
  service that is intended never to exit; existing lifetime limits still apply.

## Implementation sequence

1. Add `background` semantics and a race-safe settled-result primitive at the
   command-session layer; preserve cancellation, output bounds, and exit details.
2. Add the scoped completion inbox, deduplication, retention, and `wait_for_events`;
   wire tool registration and capability policy without enabling unrelated tools.
3. Integrate event delivery, transcript/provider adaptation, and waiting/finalization
   into the agent loop. Cover Stop, retries, and shared-loop task callers.
4. Surface waiting and command completion in the UI; update tool guidance and
   compatibility callers, then verify the end-to-end flow.

## Acceptance and verification

- Foreground: a command that outlasts the old yield interval returns its final
  result through one tool call, with no model requests during the wait.
- Background: launch returns promptly, independent agent work proceeds, and exit
  produces one completion delivered before the next eligible model request.
- Idle agent: `wait_for_events` and automatic waiting on attempted finalization
  both resume on completion without periodic model calls or a new user message.
- Immediate exit, exit during another tool/model round, several simultaneous
  completions, and exit racing with wait registration lose or duplicate no events.
- Stop while waiting or working, followed by a late exit, never restarts the agent;
  timeouts/nonzero exits report truthful terminal details and release resources.
- A completion remains available beyond the old five-minute TTL if unconsumed;
  bounded/truncated output and cursor reads remain accurate.
- Conversation/run isolation and authorization hold for forged session IDs,
  concurrent conversations, and background task/Process callers of the shared loop.
- Transcript replay and model transport retries preserve tool-call pairing and do
  not duplicate notifications or rerun commands to recover a missing result.
- Focused session/loop integration tests verify model-call counts with controlled
  events; exercise Local/container and pipe/PTY behavior where supported. Run the
  repository's required type/build gates and manually verify waiting UI plus Stop.

## Decisions to resolve during implementation

- Exact persisted runtime-event representation across supported provider adapters.
- Minimum IPC/UI additions needed to show waiting and completion independently of
  model output, and whether an existing task status can represent command waiting.
- Listener disposal/replay behavior across Environment handles, plus cleanup on
  abnormal loop exit so no command loses its owner.

The two execution modes, foreground default, and absence of routine model polling
are settled product decisions; these remaining choices concern implementation.
