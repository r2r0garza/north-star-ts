# PR74: Command completion transcript and retention

> Status: **DONE**. Make event-driven command completions durable enough for
> transcript replay, model retries, and bounded post-completion output inspection.

## Problem

PR73 should deliver background command completions to the active agent run, but the
original PR72 scope also requires durable transcript/provider semantics and output
retention rules. Those concerns are easy to blur into the inbox implementation, but
they need their own acceptance bar:

- delivered completions must replay without rerunning commands;
- model transport retries must not duplicate notifications;
- runtime events must not be recorded as orphan tool responses; and
- output needed by an undelivered completion must not disappear because the old
  completed-session five-minute TTL fired.

## Product Behavior

Background command completion is treated as a recorded runtime event, not as a new
command execution and not as a second response to the original `exec_command` call.
Once the event is incorporated into model context, transcript replay should present
the same event deterministically. If a provider request has to be retried, the same
recorded context is reused and the completion is not generated a second time.

Session output remains bounded, but a completion that has not been consumed must
retain enough data to deliver its recorded event truthfully. Truncation, dropped
bytes, cursors, cleanup errors, nonzero exits, timeouts, and signals remain visible.

## Implementation Sequence

1. Define the persisted runtime-event shape for command completions, including
   completion ID, run identity, session ID, command summary, status, exit details,
   duration, output cursor metadata, truncation flags, and bounded output.
2. Add repository/schema support only if existing message/event storage cannot
   safely represent these runtime events.
3. Adapt context-building/provider request preparation so recorded command
   completion events replay as explicit runtime notifications, never as orphan
   provider tool-call results.
4. Make consumption idempotent: an event is marked consumed only after the exact
   model context containing it has been recorded or otherwise made retry-safe.
5. Replace unconditional completed-session cleanup for undelivered completions with
   owner-aware retention. Keep explicit cleanup for consumed sessions, stopped
   runs, conversation deletion, app shutdown, and bounded resource limits.
6. Coordinate manual `poll_command` reads and event output cursors so the agent can
   inspect retained output without silently skipping or duplicating event delivery.

## Acceptance and Verification

- Transcript replay after a completed background command shows the completion
  event without rerunning the command.
- A simulated model transport retry does not duplicate a completion event.
- A completion cannot be persisted before the original background `exec_command`
  result.
- Undelivered completion output survives beyond the old five-minute completed
  session cleanup window, within explicit byte/session caps.
- Consumed completions and stopped/deleted owners release retained output.
- Polling a completed session for additional output does not consume or duplicate
  the automatic completion notification.
- Focused tests cover retry idempotency, replay shape, retention cleanup, and
  output cursor coordination.
