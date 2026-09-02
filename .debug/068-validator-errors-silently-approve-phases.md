---
status: CLOSED
severity: P1
trigger: "An API error or malformed validator response can allow an unreviewed process phase to complete"
created: 2026-09-01
updated: 2026-09-02
---

# Validator failures must not count as approval

## Confirmed behavior

At revision `21bd34d`:

- `src/main/tasks/process/service.ts`, `makeValidate`, returns `approved: true`
  when `parseVerdict` cannot parse the reviewer response.
- The same closure returns API errors as `approved: false, error, retryable`.
- `src/main/tasks/process/scheduler.ts`, `runPhaseWithRetry`, performs rework
  only for `!verdict.approved && !verdict.error`. An errored reviewer falls
  through to phase completion; the source explicitly describes fail-open.

This is confirmed code behavior, separate from the original missing-tool-result
incident. An enabled validator currently does not guarantee a successful review.

## Proposed direction

Make the review boundary distinguish approved, changes requested, unavailable,
and invalid output. Only an explicit valid approval may satisfy the validator.
Do not use truthiness or loose text matching to accept malformed verdicts.

1. Retry transient review requests through
   [066](./066-api-retries-restart-process-workers.md), retaining the exact worker
   output being reviewed. Do not rerun the worker to repair a reviewer outage.
2. Give invalid verdicts a small bounded format-correction allowance. Exhaustion
   remains invalid review, never approval. Infrastructure retries and format
   correction do not consume substantive changes-requested rounds.
3. On exhaustion or permanent review failure, hold the phase and all dependents
   in a durable actionable state. Provide a review-only retry that survives
   restart. Bind approval to the worker output revision; stale reviews cannot
   approve replaced output.
4. If allowing a manual override, expose it as a separate explicit action with
   recorded actor/context and reason. Do not auto-enable it via auto mode or
   reuse an unrelated approval decision. Cancellation remains cancellation.

Prefer existing durable gate/status mechanisms where they accurately represent
review unavailability, otherwise add a typed reason/state with migration and IPC
support. Do not add a visual-only block while marking the phase completed.

## Acceptance criteria

- [x] Reviewer 429, timeout, permanent API error, thrown exception, empty output,
      malformed JSON, and invalid verdict schema never release downstream work.
- [x] Transient recovery approves only after a valid positive verdict arrives.
- [x] Review retry reuses the completed worker output; worker invocation count
      remains one and substantive validator-round count is unchanged.
- [x] A valid negative verdict still triggers bounded rework and escalation.
- [x] Review-unavailable state, retry action, and output identity survive restart.
- [x] Nested processes propagate the hold to ancestors without orphaned spinners;
      independent in-flight siblings are drained or paused under an explicit policy.
- [x] A stale review result cannot settle a reworked phase.
- [x] Any manual override is explicit, durable, and distinguishable from approval.
- [x] Existing tests that assert fail-open behavior are replaced, not preserved.

## 2026-09-02 fail-closed baseline

Implemented in `src/main/tasks/process/service.ts` and
`src/main/tasks/process/scheduler.ts`:

- `parseVerdict` misses are now returned as validator errors instead of approval.
- Reviewer API errors, thrown exceptions, empty/malformed output, and invalid
  verdicts park the phase-run in `waiting_for_approval` and raise the existing
  durable `process_validator_gate`; downstream phases remain pending.
- The phase-run `error` field records the unavailable/invalid review reason, and
  the approval packet outcome distinguishes this from validator iteration
  exhaustion.
- Valid negative verdicts still use the existing bounded validator rework loop.

Verified with:

- `env COWORK_REQUIRE_SQLITE_TESTS=1 pnpm exec vitest run src/main/tasks/process/service.test.ts`
- `env COWORK_REQUIRE_SQLITE_TESTS=1 pnpm exec vitest run src/main/tasks/process/scheduler.test.ts`
- `npm test -- src/main/tasks/process/prompts.test.ts`
- `npm run test:sqlite`
- `npm run typecheck`

## 2026-09-02 recovery, identity, and UI completion

Completed the remaining slices in
[084](./084-validator-review-only-retry.md),
[085](./085-validator-output-identity-and-stale-review.md), and
[086](./086-validator-ui-retry-and-manual-override-audit.md):

- Validator-unavailable gates expose a `Retry review` action through
  `window.cowork.process.retryReview`; retry re-runs only the reviewer, keeps the
  completed phase worker output, and leaves `validatorRound` / `reworkRound`
  unchanged.
- Retry recovery completes only after a valid positive verdict. A valid negative
  verdict after retry enters the existing bounded validator rework loop, and
  further reviewer failure remains held behind the durable validator gate.
- Phase worker outputs now carry a durable `outputIdentity`; validator worker
  tasks persist the identity they review, and stale positive or negative results
  cannot settle or mutate a replaced phase output.
- `process:approve` is service-owned for process gates. Validator-gate approval
  records a manual override decision with gate kind, request id, phase key,
  phase-run id, actor, and failure reason; scheduler reconciliation releases the
  validator hold only when this manual-override marker is present.
- The process screen reconstructs validator gates from durable approval rows,
  distinguishes validator-unavailable, validator-exhausted, normal phase
  approval, and cross-phase flag gates, shows the stored failure reason after
  reload, and labels validator approval as `Manual override`.

Additional verification:

- `npm test -- src/main/tasks/process/service.test.ts src/main/tasks/process/scheduler.test.ts src/renderer/src/components/process-screen.test.tsx`
- `npm run typecheck`

## Likely files and dependencies

`src/main/tasks/process/service.ts`, `src/main/tasks/process/scheduler.ts`,
`src/main/tasks/process/prompts.ts`, process repositories/migrations if needed,
`src/preload/index.ts`, `src/main/index.ts`, and
`src/renderer/src/components/process-screen.tsx`, with service/scheduler/UI tests.

A fail-closed baseline can ship independently; full request retry integrates
[066](./066-api-retries-restart-process-workers.md). Use the harness from
[065](./065-tool-error-feedback-lacks-loop-integration-tests.md) and failure
records from [069](./069-process-failures-lose-stage-and-attempt-context.md).
