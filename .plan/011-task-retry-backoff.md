# PR11: Task retry with backoff — transient failures only

> Status: **BUILT** on `feat/task-retry` (not yet merged to `main`). Split out of `009` (durable task
> execution), which shipped Phase 1 (queue + background + crash-resume) without retry. Builds on the
> `TaskRunner` (`src/main/tasks/runner.ts`) and its `task_events` log from `009`.

## Context

`009`'s first cut ends a task `failed` on *any* error, transient or not — a gateway 5xx or a
network blip drops the turn just like a deterministic bad-args error does. This PR adds
retry-with-backoff so a transient failure recovers automatically, while deterministic failures and
user cancels still fail fast.

## Approach (as built)

- **Classify where the raw error still exists**, not by string-matching in the runner. The decision
  resolved during build: the `catch` in `agent/index.ts` is the single chokepoint where every
  provider error surfaces with its structured `.status`/`.code` intact — by the time `runOne` sees
  `ChatResult.error` it's already a flat string. So we added `isTransientError(err)` to
  `agent/providers/index.ts` (beside `isMaxTokensUnsupported`), classify in the catch, and carry a
  new `retryable?: boolean` back on `ChatResult`.
  - **Transient → retry:** HTTP `408`/`429`/`5xx`, or no status with a connection-layer `.code`
    (`ETIMEDOUT`, `ECONNRESET`, undici timeouts, …) / SDK `.name` (`APIConnectionError`,
    `APIConnectionTimeoutError`). (`429` is treated transient — flip in one line if product disagrees.)
  - **Deterministic → no retry:** any other 4xx, unrecognized errors, `NoActiveProviderError`
    (returns before the catch, so `retryable` stays falsy), and `stopped:true` (user Stop never retries).
- **Backoff:** capped exponential with full jitter — `random(0, min(30s, 1s * 2^(n-1)))`, max 3
  attempts (1 initial + 2 retries). On a transient failure `settleError` records the attempt, arms a
  `setTimeout` that re-enqueues + `wakeup()`s once `runOne`'s `finally` frees the slot — all
  in-memory (`attempts` + `backoffTimers` maps), no scheduler, no `next_run_at` column. `cancel`
  during backoff clears the timer and marks `cancelled`; `stop()` clears all timers; `resume()`
  resets the attempt budget.
- **Concurrency during backoff:** the slot is **freed** during the sleep, but the DB row stays
  `running` (so a crash mid-backoff reconciles to `interrupted` — see Out of scope). Because a
  backing-off task is no longer in the in-memory `running` map, `takeNext` was extended to also treat
  the conversations behind `backoffTimers` as busy — otherwise a same-conversation sibling could start
  and interleave `appendMessage` writes during the sleep.
- **Record attempts in `task_events`** via a new `attempt` lifecycle event `{ n, reason }` (mirrored
  into the preload `RunnerLifecycleEvent`); on exhausting attempts → `failed`. **No schema change.**

## Out of scope
- Crash-durable attempt counts (a crash mid-backoff just reconciles to `interrupted` and the user
  resumes — no need to persist the attempt counter to a `tasks.attempts` column).
- Scheduled/cron retries — this is reactive backoff, not a scheduler.
- A visible UI surface for `attempt` events (persisted + live-tailed, but no banner/badge yet —
  renderer consumers ignore it gracefully).

## Verification (done)
- Unit: `agent/providers/index.test.ts` covers the classifier boundary (5xx/408/429 → retry;
  400/401/403/404/422 → no; connection codes/SDK names → retry; unknown/non-object → no).
- Runner: `tasks/runner.test.ts` adds 7 cases — retry-then-succeed, exhaust budget → failed,
  deterministic fail-fast, user Stop not retried, cancel-during-backoff, stop-during-backoff,
  slot-freed-during-backoff, and same-conversation serialization across a backoff gap. A test-only
  `backoff` constructor option keeps delays tiny. Full suite: 183 passing.
  - Note: the runner/DB suites need `better-sqlite3` built for **node** (`npm rebuild
    better-sqlite3`) to run; restore the Electron build afterward (`electron-rebuild -f -w
    better-sqlite3`). Built for Electron they skip via the `sqliteLoads` guard.
- E2E: pointed a provider base URL at a local server returning `503` → 3 attempts with growing
  backoff → `failed`; returning `401` → failed on the first round with no retry.
