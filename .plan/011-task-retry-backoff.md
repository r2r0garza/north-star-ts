# PR11: Task retry with backoff — transient failures only

> Status: **NOT STARTED**. Split out of `009` (durable task execution), which shipped Phase 1
> (queue + background + crash-resume) without retry. Depends on the `TaskRunner`
> (`src/main/tasks/runner.ts`) and its `task_events` log from `009`.

## Context

`009`'s first cut ends a task `failed` on *any* error, transient or not — a gateway 5xx or a
network blip drops the turn just like a deterministic bad-args error does. This PR adds
retry-with-backoff so a transient failure recovers automatically, while deterministic failures and
user cancels still fail fast.

## Approach (hypothesis)

- **Classify the failure in `runOne`.** `runAgentLoop` already collapses errors into
  `ChatResult.error` (a string) and `stopped` (user Stop). Classify:
  - **Transient → retry:** gateway 5xx, network/timeout. Match on the error message/status the
    existing `catch` in `agent/index.ts` stringifies. (Consider surfacing a structured error code
    from `createCompletion` instead of string-matching — decide during build.)
  - **Deterministic → no retry:** provider config error (`NoActiveProviderError`), denied approval,
    blocked command, bad tool args, and `stopped:true` (user Stop **never** retries).
- **Backoff:** capped exponential with jitter, e.g. `min(30s, 1s * 2^attempt)`, max ~3 attempts.
  On a transient failure, `setTimeout` then re-enqueue + `wakeup()` (all in-memory in the runner —
  no scheduler, no `next_run_at` column). A `cancel` during backoff clears the pending timer and
  marks `cancelled`.
- **Record attempts in `task_events`** (a new `attempt` lifecycle event `{ n, reason }`); on
  exhausting attempts → `failed`. Attempt count stays in `task_events` — **no schema change**.

## Out of scope
- Crash-durable attempt counts (a crash mid-backoff just reconciles to `interrupted` and the user
  resumes — no need to persist the attempt counter to a `tasks.attempts` column).
- Scheduled/cron retries — this is reactive backoff, not a scheduler.

## Verification
- Force a transient 5xx (point a provider at a URL that 5xxs) → `attempt` events with growing
  backoff → eventually `completed` (or `failed` after max attempts).
- A denied approval / user Stop → no retry, ends `failed`/`cancelled` immediately.
