---
status: OPEN
severity: P2
trigger: "A caught tool error cannot reach the next model request while another call in the same batch never settles"
created: 2026-09-01
updated: 2026-09-01
---

# Bound tool-batch settlement without losing completed results

## Evidence and scope

At revision `21bd34d`, `src/main/agent/tool-batch-scheduler.ts`, `runBatch`,
awaits `Promise.all` of its workers. `onBatchSettled` runs only after the whole
batch completes. The loop persists results in that callback, so one unsettled
read can delay both another read's error feedback and its durable result.

The batch scheduler has no direct abort/deadline input. Individual tools receive
a signal through their execution context and some have their own deadlines;
this is not a claim that all tools ignore cancellation. In particular,
[050](./050-mcp-call-lifecycle-unbounded.md) already added bounded MCP calls.
The gap here is the shared batch boundary and per-call result durability.

## Proposed direction

Add an explicit cancellation/deadline contract for scheduled tool calls, with
tool-specific policies rather than an arbitrary universal timeout. Long-running
commands may already expose resumable sessions; preserve that model.

- Persist each settled call once, keyed by call ID, instead of delaying every
  durable result until the slowest sibling finishes. Preserve original call
  ordering in the next model request and deterministic transcript rendering.
- Stop dequeuing work after abort. On deadline/cancel, settle promptly or expose
  an unknown outcome with the policy from
  [067](./067-interrupted-tools-risk-duplicate-side-effects.md).
- A `Promise.race` timeout alone does not stop execution. Propagate cancellation,
  clean up the backend where supported, and quarantine late completions so they
  cannot mutate settled run state or silently duplicate terminal results.
- Preserve mutation barriers: do not start subsequent actions while a preceding
  mutation may still be active. A read timeout may yield a recoverable result;
  an uncertain side effect must not be reported as definitely failed/no effect.
- Separate lifecycle/persistence callback failures from tool exceptions and
  surface them through [069](./069-process-failures-lose-stage-and-attempt-context.md).

## Acceptance criteria

- [ ] A completed error and successful sibling are persisted while a third read
  remains pending; fake deadlines make the batch settle deterministically.
- [ ] The next model request contains exactly one result per call, in valid
  order, including a correctly classified timed-out or unknown result.
- [ ] Stop during a batch prevents undispatched calls and subsequent mutation
  barriers from starting; no retry begins after cancellation.
- [ ] Late settlement after deadline cannot overwrite terminal state or create
  duplicate results. Supported backends demonstrate cancellation/cleanup, not
  only a resolved timeout promise.
- [ ] Unsupported cancellation of a side-effecting tool records uncertainty and
  blocks hazardous replay rather than pretending the action was undone.
- [ ] Persistence failure produces a persistence-stage failure, not a fake
  successful tool result or misleading provider error.
- [ ] Existing parallel-read ordering and concurrency tests remain green.

## Likely files and dependencies

`src/main/agent/tool-batch-scheduler.ts`, `src/main/agent/index.ts`,
`src/main/agent/tools/types.ts`, applicable environment/tool lifecycle code,
message/lifecycle persistence, and their tests. Extend
[065](./065-tool-error-feedback-lacks-loop-integration-tests.md); coordinate
durability changes with [067](./067-interrupted-tools-risk-duplicate-side-effects.md).

