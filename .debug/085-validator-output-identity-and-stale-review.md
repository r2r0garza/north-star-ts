---
status: RESOLVED
severity: P1
trigger: "A stale validator result can approve a phase output that has since been replaced"
created: 2026-09-02
updated: 2026-09-02
---

# Bind validator approval to the reviewed phase output

## Context

[068](./068-validator-errors-silently-approve-phases.md) prevents invalid or
errored validator responses from approving a phase. The remaining correctness
gap is identity: a validator result must approve only the exact phase worker
output it reviewed.

Without a durable review target identity, an old reviewer conversation or
delayed result can be resumed after the phase has been reset, reworked, or
otherwise replaced. That stale result must not settle the newer phase output.

## Proposed direction

Persist a stable identity for the phase output under review. Candidate identity
fields include the worker task id plus final assistant message id, a phase output
revision, or a hash over a canonical output record. The chosen identity must be
cheap to compare, survive restart, and change whenever the reviewed worker output
is replaced.

Every validator worker task should record the output identity it was asked to
review. Scheduler settlement must compare the returned validator task's review
target against the current phase output identity before approval or rejection
affects the phase. Stale results should be ignored or held as stale review state,
never treated as approval.

## Acceptance criteria

- [x] Validator review tasks persist the exact phase output identity they review.
- [x] Phase reset/rework changes the current output identity before another review
  can approve it.
- [x] A stale positive validator result cannot mark a reworked phase completed.
- [x] A stale negative validator result cannot inject feedback into the new
  worker attempt.
- [x] Resume of an existing validator worker verifies its target identity before
  reusing the conversation.
- [x] Output identity survives app restart.
- [x] Tests cover delayed stale approval, delayed stale rejection, and normal
  same-output approval.

## Likely files

`src/main/tasks/process/service.ts`, `src/main/tasks/process/scheduler.ts`,
message/task repositories, process DB migrations if a first-class output revision
is added, and SQLite-backed service/scheduler tests.
