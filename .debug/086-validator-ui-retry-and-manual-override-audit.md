---
status: CLOSED
severity: P2
trigger: "Validator-unavailable holds need a clear UI action and manual overrides must be distinguishable from validator approval"
created: 2026-09-02
updated: 2026-09-02
---

# Expose validator retry and audited manual override

## Context

[068](./068-validator-errors-silently-approve-phases.md) parks invalid or errored
validator reviews behind a durable `process_validator_gate`. That prevents silent
approval, but the UI still needs to make the state and available actions
unambiguous.

Approving a validator-unavailable gate is a manual override, not a validator
approval. The product should expose that distinction in state, copy, and audit
records.

## Proposed direction

Render validator-unavailable gates with their failure reason and a retry-review
action from [084](./084-validator-review-only-retry.md). Keep approve/request
changes available only with explicit wording that approval is a manual override
of an unavailable review.

Persist override decisions with actor/context and reason where possible. Do not
reuse a stale or unrelated validator approval record. Reloaded process screens
should reconstruct the same state from durable rows, without depending on live
events.

## Acceptance criteria

- [x] The process screen distinguishes validator exhaustion, validator
      unavailable/invalid, normal phase approval, and cross-phase flag gates.
- [x] Validator-unavailable gates show the stored failure reason after reload.
- [x] Retry-review is visible and wired through `window.cowork` IPC.
- [x] Manual override is explicit and stored distinctly from validator approval.
- [x] Auto mode cannot silently manual-override a validator-unavailable gate.
- [x] Request changes still resets the phase through the existing rework path.
- [x] UI tests or component tests cover the visible states and action wiring.

## Resolution

Implemented a service-owned `process.approve` path that records validator-gate
approval as a manual override decision with phase/request context and the stored
failure reason, while leaving normal phase approval on the existing decision
path. Scheduler reconciliation now releases validator gates only when that
manual-override marker is present, so a generic approved row cannot silently
stand in for validator approval.

The process screen now labels validator-unavailable, validator-exhausted, normal
phase approval, and cross-phase flag states distinctly. Validator gates show the
durable approval packet summary after reload, expose Retry review separately, and
label approval as Manual override.

Verification:

- `npm test -- src/main/tasks/process/service.test.ts src/main/tasks/process/scheduler.test.ts src/renderer/src/components/process-screen.test.tsx`
- `npm run typecheck`

## Likely files

`src/renderer/src/components/process-screen.tsx`, `src/preload/index.ts`,
`src/main/ipc/process-handlers.ts`, `src/main/tasks/process/service.ts`,
approval repository/types, and process UI tests.
