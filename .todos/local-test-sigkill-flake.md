# TODO: harden flaky SIGKILL timing test in local.test.ts

## Symptom
`src/main/agent/env/local.test.ts` intermittently fails under the full `pnpm test`
run at:

```
it("reaps the whole process group on abort (no orphaned grandchild)")
  expect(r.signal).toBe("SIGKILL")   // line ~98
  Received: null
```

It **passes reliably in isolation** (`pnpm exec vitest run src/main/agent/env/local.test.ts`
→ 18/18). So it's a timing flake under full-suite load, not a real regression.
Observed 2026-07-01 during the repo-wide prettier reformat run (formatting was
unrelated — the reformat only rewrapped `local.ts`).

## Likely cause
The test spawns `sleep 30 | grep <marker>` and calls `ac.abort()` after a fixed
`setTimeout(..., 100)`. Under a loaded machine (whole suite running in parallel),
the 100ms timer can fire before the shell/child has fully spawned, so the abort
races process startup and `exec` resolves without a `SIGKILL` signal (`r.signal`
is `null`). The sibling timeout-based tests (100ms `timeoutMs`) are suspect for the
same reason.

## Fix ideas (pick when picked up)
- Don't race a fixed wall-clock timer against spawn: abort **after** the child is
  confirmed running (e.g. wait for first stdout/stderr byte or a "started" marker
  before calling `ac.abort()`), instead of a bare `setTimeout(100)`.
- Or increase the pre-abort delay and/or run these process-group tests serially
  (vitest `describe.sequential` / isolate the file to its own pool) so they don't
  compete for CPU with the rest of the suite.
- Confirm `exec`'s result actually surfaces the kill signal deterministically when
  abort lands during spawn — if abort before spawn should still report `SIGKILL`,
  that's a `local.ts` behavior gap, not just a test-timing issue.

## Files
- `src/main/agent/env/local.test.ts` — the three process-group reaping tests
  (abort ~L87, timeout ~L108, and the earlier SIGKILL case ~L72).
- `src/main/agent/env/local.ts` — `LocalEnvironment.exec` abort/timeout + signal
  reporting.

## Provenance
Split off 2026-07-01 from the prettier-reformat work so the flake gets its own
attention rather than being buried in a formatting commit.
