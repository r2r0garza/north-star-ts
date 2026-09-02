---
status: CLOSED
severity: P1
trigger: "Process worker resume and rerun paths may bypass generic unknown side-effect recovery semantics"
created: 2026-09-02
updated: 2026-09-02
---

# Align process worker recovery with tool outcome safety

## Context

[067](./067-interrupted-tools-risk-duplicate-side-effects.md) specifically calls
out process retries creating fresh worker conversations. Related work in
[066](./066-api-retries-restart-process-workers.md),
[069](./069-process-failures-lose-stage-and-attempt-context.md), and
[074](./074-auto-resume-must-not-refresh-model-retry-budget.md) reduced some
fresh-worker replay risk, but process-specific resume/rerun semantics still need
to be audited against the durable tool lifecycle.

## Risk

A process run can resume, rework, validate, or rerun a phase through code paths
that differ from ordinary task resume. If those paths create fresh worker
conversations or discard unresolved tool evidence, side-effecting work can be
duplicated while the monitor shows only phase-level progress.

## Proposed direction

Audit process worker creation, resume, retry, validation, rework, and whole-run
rerun flows. Ensure they reuse existing worker transcripts for continuation,
honor lifecycle unknown-outcome guards, and make deliberate reruns explicit.

Explicit whole-phase reruns should warn about prior effects and retain audit
history instead of overwriting it.

## Acceptance criteria

- [x] Process resume reuses existing worker transcripts when continuing work.
- [x] Process retry/rerun checks unresolved side-effecting tool outcomes before
      creating fresh workers.
- [x] Deliberate whole-phase rerun is distinct from continuation.
- [x] Explicit reruns warn about prior known or unknown effects.
- [x] Audit history and prior worker transcripts remain available after rerun.
- [x] Process monitor surfaces unresolved tool outcome blockers clearly.

## Resolution

Process rerun entry points now refuse to reset phase state while any attached
process worker transcript has unresolved side-effecting tool outcomes. Normal
phase, decomposition, and validator continuation paths reuse their existing
worker conversations; validator workers are keyed by `phaseRunId` and
`validatorRound` so a crash-resume continues the same review, while a later
validator round remains a deliberate new review. The blocker is surfaced through
the existing process action error path with the unresolved tool names.

## Likely files

`src/main/tasks/process/service.ts`, `src/main/tasks/process/scheduler.ts`,
`src/main/tasks/process/*.test.ts`, `src/main/tasks/runner.ts`, lifecycle
repository, and process monitor UI as needed.
