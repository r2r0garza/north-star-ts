---
status: CLOSED
severity: P2
trigger: "An agent can receive a tool error and then stop with an explanation without actually completing its assigned phase"
created: 2026-09-01
updated: 2026-09-02
---

# Distinguish an ended model turn from successful phase work

## Evidence and boundary

At revision `21bd34d`, `src/main/agent/index.ts`, `runAgentLoop`, treats a
tool-free answer as a final `{ content }` result. An ordinary phase in
`src/main/tasks/process/scheduler.ts` can then complete without validating the
requested work, unless a validator is configured. This is a contract gap, not
proof that any particular final answer in the reported incident was wrong.

Tool-error delivery, agent recovery decisions, and objective completion are
three different claims. [065](./065-tool-error-feedback-lacks-loop-integration-tests.md)
can prove the first. Neither retry plumbing nor a scripted model test proves
that every real model solves its assigned objective.

## Proposed direction

Add a process-only explicit outcome contract: completed, blocked, or failed,
with output/evidence and actionable reason as appropriate. Preserve freeform
conversation answers; do not require ordinary chats to produce process JSON.
Treat a model-declared completion as a claim, not ground truth.

For phases with machine-checkable deliverables, allow explicit completion
checks tied to the phase definition: required artifacts in the confined
workspace, output schema, or configured safe verification results. For semantic
review use the fail-closed validator from
[068](./068-validator-errors-silently-approve-phases.md). Do not run arbitrary
model-supplied verification commands as trusted checks or bypass approval policy.

Specify compatibility before changing existing definitions. A proposed rollout
is an explicit legacy vs validated completion policy, with new definitions
guided toward validated behavior. Existing runs must retain their recorded
contract; any migration or opt-in must be visible. Missing/invalid required
completion evidence cannot silently fall back to success.

Do not detect failure with phrases such as "I couldn't" or fail a phase merely
because an earlier tool returned an error: later recovery may have succeeded.
Keep semantic rework budgets separate from transport retries and review outage
retries. An unresolved outcome must hold dependents and expose a suitable action.

## Acceptance criteria

- [x] Under the explicit outcome contract, scripted blocked/failed outcomes do
  not release dependent phases, even when the answer contains no tool calls.
- [x] Invalid or missing required outcome data is not treated as success.
- [x] A declared completion with a missing required artifact/check fails its
  contract, while an actually recovered tool error can still complete.
- [x] Ordinary chat behavior is unchanged; legacy process policy is explicit.
- [x] Checks respect workspace boundaries and normal execution permissions.
- [x] Validated outputs and contract version survive resume/rework; stale
  evidence from an earlier worker cannot satisfy a new attempt.
- [x] Builder, monitor, service, and scheduler tests cover the chosen rollout.

## Likely files and sequencing

Process definitions/types/repositories and migrations, process prompts/service/
scheduler, `src/main/agent/index.ts` only where a typed result seam is needed,
main/preload IPC, and `src/renderer/src/components/process-screen.tsx`.

This is an explicit product contract change, not a mandatory prerequisite for
request retries. Implement after the core recovery and validator fixes. Record
the selected rollout and schema in this brief before coding; do not claim a
general guarantee of model correctness on closure.


## Selected rollout and v1 contract (2026-09-02)

- Each phase has `completionContract`: `{ policy: "legacy" }` or
  `{ policy: "validated", version: 1, requiredArtifacts: string[] }`.
  Migration and omitted API/import fields retain legacy behavior. The builder
  explicitly selects validated v1 for newly added phases and exposes opt-in/out.
- Runs snapshot all phase completion contracts at creation. Pre-migration runs
  have a null snapshot and stay legacy, including after resume/rework. Newly
  inserted phases in an existing snapshotted run fail closed if not recorded.
- Every validated worker (including fan-out children and each-subtask consumers)
  must end with one JSON object: `version: 1`, the supplied `attemptId`,
  `status: "completed" | "blocked" | "failed"`, nonempty `output` and `evidence`
  strings; blocked/failed also require nonempty `reason` and `nextAction`.
  Subprocess/container completion is derived from its children; nested runs
  snapshot their own contracts when created.
- V1 machine checks support required regular files in the confined workspace,
  using lexical and realpath guards. No verification commands are executed.
  File presence is evidence only, not semantic correctness or proof of authorship;
  use the existing validator for semantic review. Arbitrary output schemas and
  configured command checks are deferred beyond v1.
- Invalid outcomes, missing files, and blocked/failed declarations fail the phase
  with an actionable error and hold dependents. Existing Restart run is recovery;
  there is no automatic semantic retry or approval bypass for these failures.
- Persist the parsed outcome, checked file list, timestamp, and attempt identity.
  Clear evidence on a new worker attempt/reset/rework. Resume of an interrupted
  worker gets a fresh attempt instruction without changing conversation resume
  semantics. Review-only retries retain the current receipt and output identity.

## Resolution and verification (2026-09-02)

Implemented schema v41, authoring/import validation, per-run policy snapshots,
process-only outcome instructions, scheduler enforcement, and persisted outcome
receipts. The builder defaults newly added phases to validated v1 and exposes
legacy opt-in/out; the monitor displays recorded policies, declared evidence,
file-check status, and actionable failures. Restart run uses existing recovery;
review-only retries preserve the receipt, while replacement worker attempts and
rework clear it. Pre-contract runs remain legacy.

Verification:

- `COWORK_REQUIRE_SQLITE_TESTS=1 pnpm test`: 1,377 passed, 41 skipped;
  SQLite-backed contract suites executed (no ABI fallback).
- `pnpm typecheck` and `pnpm build` pass.
- Real agent-loop integration scripts a failed file read, successful correction,
  and completed/blocked/failed/invalid outcomes. Only valid completion passes.
- Scheduler tests prove held dependents, missing-artifact rejection, recovery,
  fan-out enforcement, legacy compatibility, and stale-attempt rejection.
- Service tests cover resumed-worker instructions, immutable policy selection,
  review-only receipt retention, and semantic rework with a fresh attempt.
- Migration, import/export, builder, monitor, and workspace/symlink confinement
  tests cover the rollout and durable contract.

This establishes the specified v1 outcome/file-presence contract. It does not
establish general model correctness or prove authorship/semantic correctness of
an existing file; use the validator for semantic review. No arbitrary command
verification or configurable output-schema language is included in v1.
