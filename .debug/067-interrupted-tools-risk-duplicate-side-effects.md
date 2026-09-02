---
status: OPEN
severity: P1
trigger: "Automatic phase replay and incomplete-turn rollback can repeat work whose external effect already happened"
created: 2026-09-01
updated: 2026-09-01
---

# Preserve tool outcomes and make interrupted replay safe

## Evidence and risk

At revision `21bd34d`, `src/main/agent/repair.ts` implements `rollback` by
deleting the last incomplete assistant tool-call turn and every following
message, including results from completed siblings. `runAgentLoop` chooses this
mode when resuming without a fresh user message. Process retries also create
fresh worker conversations in `src/main/tasks/process/service.ts`.

A command or external mutation can succeed before its result is persisted.
After an interruption, neither deleting the request nor appending an unknown
result proves that the action did not occur. Automatic re-planning can repeat
it. This is a risk demonstrated by the control flow, not a claim that the
reported remote run duplicated an action.

## Proposed direction

Introduce durable per-call execution evidence sufficient to distinguish:

- prepared or waiting for approval, demonstrably not started;
- started with no durable terminal result: outcome unknown;
- settled with a known success or error result.

Persist intent before execution and terminal evidence as each call settles.
Use a stable invocation identity across recovery. Do not promise exactly-once
external execution: a local transaction cannot atomically commit arbitrary
remote effects. Where a tool supports idempotency keys or queryable operation
IDs, preserve those and reconcile before retrying.

Recovery must preserve completed results and the original conversation. Safe
reads may be retried under an explicit policy. Unknown side-effecting calls
require reconciliation or explicit intervention. An unknown result must not be
handed to an unrestricted model that can simply issue the same action again;
gate hazardous replay until resolution, including equivalent calls with new IDs.
Never infer a mutation's failure solely from a timeout or thrown exception.

Maintain API-valid call/result pairs without erasing successful sibling evidence.
Keep approval recovery distinct: a call known not to have started must re-prompt
when appropriate, not receive a synthetic approval or denial. Legacy dangling
calls without lifecycle evidence default conservatively to unknown.

## Acceptance criteria

- [ ] Fault injection before execution, after external effect, and before result
  persistence produces the appropriate not-started/unknown/settled outcome.
- [ ] Resume preserves completed sibling results and does not repeat their actions.
- [ ] Unknown mutations block automatic replay, including after app restart or
  a fresh model-generated call ID; read-only recovery remains available.
- [ ] Idempotent reconciliation resumes using the original operation identity.
- [ ] Pending approvals re-prompt without inventing a user decision.
- [ ] User retry distinguishes continuation from deliberate whole-phase rerun;
  explicit reruns warn about prior effects and retain audit history.
- [ ] Migration handles legacy incomplete transcripts without claiming certainty.
- [ ] Cancellation stops scheduling new work and records unresolved outcomes.

## Likely files and dependencies

`src/main/agent/repair.ts`, `src/main/agent/index.ts`,
`src/main/agent/tool-batch-scheduler.ts`, `src/main/agent/tools/types.ts`,
`src/main/db/repositories/messages.ts`, DB migrations/repositories as needed,
`src/main/tasks/process/service.ts`, and `src/main/tasks/runner.ts`.

Coordinate [066](./066-api-retries-restart-process-workers.md),
[069](./069-process-failures-lose-stage-and-attempt-context.md), and
[071](./071-tool-batches-delay-error-feedback-and-cancellation.md).
The first delivery can prevent fresh-worker automatic replay and retain known
results; durable unknown-outcome handling is still required before closing.

