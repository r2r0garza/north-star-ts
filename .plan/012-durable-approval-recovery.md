# PR12: Durable approval recovery — survive a restart while waiting_for_approval

> Status: **NOT STARTED**. Split out of `009` (durable task execution). Depends on the
> `TaskRunner` from `009` and the existing in-memory approval gate in
> `src/main/agent/index.ts` (`pendingApprovals` map, `resolveApproval`).

## Context

`009`'s first cut keeps approvals exactly as the live `chat` path has them: an in-memory
`pendingApprovals` map (`agent/index.ts:64`). When a task's tool needs human approval the gate
emits an `approval` event and blocks on a Promise stored in that map. If the app quits while a task
is blocked, the pending request is lost — there's no durable record, and the `waiting_for_approval`
task status (already in the schema) is never even set by `009`. This PR makes a blocked task
recoverable across a restart by dual-writing the gate to the `approvals` table.

## Approach (hypothesis)

- **Dual-write the gate.** Give the gate an optional persist hook passed via `RunAgentLoopOptions`,
  so the live `chat` path stays unchanged and the runner path also:
  - on `require_approval`: `approvals.createApproval({ taskId, request: { tool, summary, reason, requestId } })`
    and set the task status → `waiting_for_approval` (a `status_change` event); keep the in-memory
    Promise for the live case.
  - on resolve: `approvals.resolveApproval(approvalId, { status, decision })` **and** the in-memory
    `resolveApproval(requestId, …)`; task status → `running`.
- **Restart recovery.** `009`'s reconcile already moves `waiting_for_approval` → `interrupted`. On
  resume, because the loop rebuilds context from persisted messages and the blocked tool never
  produced a result, the gate is re-entered naturally and re-creates the approval — i.e. the
  simplest correct behavior is to **re-prompt on resume**. Resolving a decision the user made while
  the app was closed is explicitly out of scope.
- Reuse the existing `approvals` table + repository (`createApproval`/`listApprovals`/
  `resolveApproval`) — **no schema change**.

## Out of scope
- Persisting/replaying a decision made while the app was closed (re-prompt on resume instead).
- The `ask_user_question` gate's durability (same in-memory pattern; revisit if needed).

## Verification
- A task hits `waiting_for_approval` (a tool requiring approval) → a `pending` row appears in
  `approvals`; quit + relaunch → the task reconciles to `interrupted`; resume → it re-prompts and,
  on approval, completes.
