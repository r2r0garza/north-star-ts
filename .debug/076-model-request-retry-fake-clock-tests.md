---
status: CLOSED
severity: P1
trigger: "Model-request retry timing and abort behavior is not covered by deterministic tests"
created: 2026-09-02
updated: 2026-09-02
---

# Add fake-clock tests for model request retries

## Context

The first 066 implementation added integration coverage for retrying transient
completion failures and discarding partial stream attempts. Timing-sensitive
behavior still needs deterministic fake-clock coverage.

## Required cases

- Capped exponential backoff with injected/deterministic jitter.
- Valid `Retry-After` seconds.
- Valid `Retry-After` HTTP date.
- `Retry-After` or computed delay exceeding the remaining elapsed-time budget.
- Exhaustion by attempt count.
- Cancellation during backoff.
- Shutdown during backoff.
- No late provider request after abort.
- Auto-resume after exhaustion makes zero new transport attempts.

## Proposed direction

Make retry timing testable without depending on wall-clock time.

- Inject clock/sleep/jitter seams into the retry coordinator, or extract it into a
  small testable module.
- Keep production defaults unchanged.
- Assert provider call count and durable retry state transitions.
- Assert that abort clears pending sleeps and prevents later provider access.

## Acceptance criteria

- [x] Fake-clock tests cover all required cases above.
- [x] Tests assert provider transport attempt count, not only returned errors.
- [x] Tests assert no abandoned partial stream text/tool fragments are persisted.
- [x] Tests pass without real timers or network access.

## Likely files

`src/main/agent/index.ts`, a possible extracted retry coordinator module,
`src/main/agent/*.test.ts`, and the durable repository from
[072](./072-persist-model-request-retry-budget.md).

## Resolution

Extracted the native model-request retry coordinator into
`src/main/agent/model-request-retry.ts` with injectable clock, sleep, jitter,
transient classification, repository, and transport seams. Production defaults
preserve the existing `Date.now`, `Math.random`, `setTimeout`, provider stream,
and durable retry-budget behavior.

Added deterministic coverage in `src/main/agent/model-request-retry.test.ts` for
capped exponential backoff, `Retry-After` seconds and HTTP-date values,
remaining-budget exhaustion, attempt-count exhaustion, cancellation and shutdown
during backoff, no late provider access after abort, abandoned stream fragment
discard, and zero transport attempts when auto-resuming an exhausted budget. The
existing agent-loop integration test continues to assert no abandoned partial
text or tool fragments are persisted.

Verification:

- `npm test -- src/main/agent/model-request-retry.test.ts src/main/agent/tool-error-feedback.integration.test.ts`
- `npm run typecheck`
