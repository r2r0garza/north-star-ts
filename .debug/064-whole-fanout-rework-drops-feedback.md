---
status: Fixed
severity: P2
trigger: "A flag_for_rework send-back targeting an entire fan-out phase re-runs decomposition without telling the decomposition agent why the phase was sent back"
created: 2026-09-01
updated: 2026-09-01
---

# Whole fan-out rework drops the flag feedback

## Symptoms

- Expected: when a later process phase calls `flag_for_rework` against an
  earlier fan-out phase, the re-run receives the flag's actionable `reason` and
  uses it when decomposing the replacement sub-tasks.
- Actual: the engine records the reason on the fan-out container's
  `reworkNote`, deletes its prior children and checkpoints, and starts a fresh
  decomposition worker, but that worker receives only the original objective,
  upstream phase output, and generic decomposition instructions.
- The decomposition prompt contains no `## Requested changes` section and no
  other copy of the flag reason.
- The replacement child briefings therefore receive no guaranteed feedback
  either. The fan-out phase may repeat the same decomposition and reproduce the
  defect that caused the send-back.
- No runtime error is raised; the process appears to honor the send-back while
  silently losing its purpose at the worker boundary.

## Observed Prompt Shape

The re-run begins with:

```text
# Process phase (fan-out): build

You are planning one phase of a larger multi-phase process. This phase FANS OUT...

## Overall objective
...

## Output of the phases that ran before you
...

## Your task
Decompose the "build" phase into independent sub-tasks...
```

There is no `## Requested changes` section containing the `flag_for_rework`
reason.

## Root Cause

The whole-phase flag-back path correctly preserves the reason at the data
boundary but the fan-out decomposition prompt does not consume it:

1. `applyWholePhase` passes the flag's `reason` to `resetContainerWhole` for the
   target phase.
2. `resetContainerWhole` persists that value as the top-level container phase
   run's `reworkNote` and resets the container to `pending`.
3. The scheduler re-enters the fan-out decomposition path.
4. `makeDecompose` calls `fanOutDecomposePrompt` with only `phase`, `objective`,
   and `upstream`.
5. `fanOutDecomposePrompt` has no `reworkNote` parameter and cannot render the
   stored feedback.

This differs from ordinary phase execution, where `makeRunPhase` reads the
fresh phase-run `reworkNote` and passes it to `kickoffPrompt`, which renders a
`## Requested changes` section.

## Scope and Behavior Matrix

| Rework target | Current feedback delivery |
| --- | --- |
| Ordinary non-container phase | Delivered through `kickoffPrompt` |
| Specific fan-out child | Delivered by appending to the child's stored sub-task prompt |
| Entire fan-out phase | **Dropped from the decomposition worker prompt** |
| Downstream ordinary phase reset because an upstream phase changed | Receives a generic re-check note |
| Downstream container reset because an upstream phase changed | Its stored generic note is subject to the same decomposition omission |

The primary defect is the target whole-fan-out case. The downstream-container
case should be handled by the same prompt plumbing so a reset container also
knows that its upstream input changed.

## Recommended Direction

1. Extend `fanOutDecomposePrompt` to accept an optional `reworkNote`, matching
   the ordinary `kickoffPrompt` contract.
2. Render a `## Requested changes` section before `## Your task` when the note is
   non-empty. The wording should distinguish direct feedback from the generic
   downstream re-check note without changing the strict JSON-only response
   contract.
3. In `makeDecompose`, read the current phase run from the database immediately
   before building each decomposition attempt and pass its fresh `reworkNote`.
   Reading fresh mirrors `makeRunPhase` and avoids relying on a stale closure
   object after a reset.
4. Preserve the note across parse retries so every newly created decomposition
   worker sees both the feedback and, when applicable, the JSON-format retry
   coda.
5. Do not append the feedback separately to every newly generated child prompt
   by default. The decomposition agent should incorporate it into complete,
   self-contained replacement briefings; blindly duplicating the note can make
   children responsible for changes outside their assigned slice.

## Likely Files

- `src/main/tasks/process/prompts.ts`
- `src/main/tasks/process/service.ts`
- `src/main/tasks/process/prompts.test.ts`
- `src/main/tasks/process/service.test.ts`
- potentially `src/main/tasks/process/flagback.test.ts` or the existing
  scheduler/service flag-back coverage

## Acceptance Criteria

- A whole-phase `flag_for_rework` targeting a fan-out phase causes the new
  decomposition prompt to include the exact actionable flag reason under a
  clearly labeled requested-changes section.
- The prompt still requires and successfully parses a JSON array of string
  briefings; feedback delivery does not weaken the decomposition output
  contract.
- A fan-out decomposition parse retry retains the requested-changes feedback
  and also includes the format-correction note.
- A whole fan-out reset caused by upstream rework includes the generic
  downstream re-check note in its fresh decomposition prompt.
- A first-run fan-out decomposition contains no empty or placeholder requested-
  changes section.
- Existing ordinary-phase and per-child fan-out feedback behavior remains
  unchanged.
- An end-to-end regression test exercises `flag_for_rework` against the whole
  fan-out phase, resumes the process, and asserts against the actual
  decomposition worker's `userMessage`, not only the persisted `reworkNote`.

## Evidence

- `src/main/tasks/process/flagback.ts`: `applyWholePhase` passes the direct flag
  reason to `resetContainerWhole`, which persists it as `reworkNote`.
- `src/main/tasks/process/service.ts`: ordinary phase execution reads the fresh
  `reworkNote` for `kickoffPrompt`, while `makeDecompose` does not read or pass
  one.
- `src/main/tasks/process/prompts.ts`: `kickoffPrompt` accepts and renders
  `reworkNote`; `fanOutDecomposePrompt` accepts only phase, objective, and
  upstream results.
- `src/main/tasks/process/flagback.ts`: the separate per-child path explicitly
  appends the reason to the stored child prompt, confirming that feedback loss
  is specific to whole-container decomposition rather than all fan-out rework.

## Eliminated

- hypothesis: the flag reason is never persisted.
  reason: `resetContainerWhole` stores it on the target container phase run as
  `reworkNote`.
- hypothesis: the monitor merely hides feedback that the worker still receives.
  reason: the actual fan-out prompt builder and its caller have no feedback
  input, matching the observed worker message.
- hypothesis: all fan-out send-backs lose feedback.
  reason: a specific child target uses `reinjectChildPrompt` and receives a
  dedicated requested-changes section without re-running decomposition.
