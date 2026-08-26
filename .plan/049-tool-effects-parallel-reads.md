# PR49: Tool effect metadata and parallel read-only execution

> Status: **NOT STARTED**. Fourth tool-quality slice. No schema migration.

## Context

`runAgentLoop` executes every tool call in a simple `for...of`, even when the
model emits independent reads/searches in one response. The `Tool` interface
does not declare whether a call reads, mutates, is idempotent, can run in
parallel, or reaches outside the workspace. Those facts are duplicated
implicitly across tool lists and approval classifiers.

## Goal

Give every built-in tool explicit effect metadata, validate it in tests, and run
safe read-only batches concurrently while preserving transcript ordering,
cancellation, approvals, and deterministic mutation order.

## Design

Extend `Tool` with required metadata:

```ts
type ToolEffects = {
  readOnly: boolean
  parallelSafe: boolean
  idempotent: boolean
  destructive: boolean
  openWorld: boolean
}
```

- Metadata is mandatory for every static tool; a missing declaration is a
  compile/test failure, not an unsafe default.
- `read_file`, `list_files`, index queries, and read-only search are initial
  parallel candidates.
- File mutations, shell, questions, approvals, browser mutations, delegation,
  todos, dashboards, and Process tools remain sequential.
- External MCP tools remain sequential unless their MCP annotations explicitly
  mark them read-only and the North Star policy permits parallel execution.

### Scheduler

- Partition each model-emitted tool-call list into maximal consecutive batches:
  parallel-safe reads may run together; every other call is a one-item barrier.
- Start/done events reflect real timing, but append tool-result messages and DB
  rows in the model's original call order after the batch settles.
- Use `Promise.allSettled`; one read failure becomes that call's tool result and
  does not cancel siblings. Turn abort propagates to all calls.
- Image side effects remain per-call and are reassembled in original call order.
- Apply a small concurrency cap to avoid file-descriptor/CPU spikes when a model
  emits many reads.

### Metadata consumers

- Derive MCP `readOnlyHint`/destructive hints from the same source where relevant.
- Surface effect badges in development diagnostics and use assertions to prevent
  a tool marked `readOnly` from registering a mutating approval action.
- Do not automatically approve a tool merely because it claims `readOnly`; the
  approval policy remains authoritative.

## Implementation areas

- `tools/types.ts` and every built-in tool definition.
- Extract the tool-call execution block in `agent/index.ts` into a testable batch
  scheduler with injected call executor/persistence hooks.
- MCP adapter metadata mapping and targeted approval consistency assertions.

## Verification

- Two delayed reads overlap in wall-clock time and results persist in call order.
- A read before and after an edit does not cross the mutation barrier.
- Failure, malformed arguments, Stop, images, questions, and approvals preserve
  existing transcript invariants.
- Concurrency never exceeds the cap.
- Metadata inventory test covers every registered tool and rejects contradictory
  combinations such as `parallelSafe:true` with `readOnly:false` in v1.
- End-to-end regression proves providers that emit one tool at a time are
  behaviorally unchanged.

## Out of scope

- Parallel mutations or automatic dependency analysis between tool arguments.
- Parallel Process phases; that belongs to the Process scheduler.
- Treating model/MCP metadata as a security boundary.
