---
status: OPEN
severity: P2
trigger: "An agent can receive a tool error and then stop with an explanation without actually completing its assigned phase"
created: 2026-09-01
updated: 2026-09-01
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

- [ ] Under the explicit outcome contract, scripted blocked/failed outcomes do
  not release dependent phases, even when the answer contains no tool calls.
- [ ] Invalid or missing required outcome data is not treated as success.
- [ ] A declared completion with a missing required artifact/check fails its
  contract, while an actually recovered tool error can still complete.
- [ ] Ordinary chat behavior is unchanged; legacy process policy is explicit.
- [ ] Checks respect workspace boundaries and normal execution permissions.
- [ ] Validated outputs and contract version survive resume/rework; stale
  evidence from an earlier worker cannot satisfy a new attempt.
- [ ] Builder, monitor, service, and scheduler tests cover the chosen rollout.

## Likely files and sequencing

Process definitions/types/repositories and migrations, process prompts/service/
scheduler, `src/main/agent/index.ts` only where a typed result seam is needed,
main/preload IPC, and `src/renderer/src/components/process-screen.tsx`.

This is an explicit product contract change, not a mandatory prerequisite for
request retries. Implement after the core recovery and validator fixes. Record
the selected rollout and schema in this brief before coding; do not claim a
general guarantee of model correctness on closure.

