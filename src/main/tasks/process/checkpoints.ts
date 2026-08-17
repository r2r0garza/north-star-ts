// Shared checkpoint label formats + persisted-state shapes for the Process engine
// (plans 025.1 / 025.2). Extracted from the scheduler so the flag-back reset module
// (plan 031.2) can locate and DELETE a container's stale checkpoints on reset
// without an import cycle. The scheduler owns writing/reading these; flagback.ts
// only needs the label prefixes + the state shapes to find the right rows.

// The checkpoint label for a fan-out parent's persisted sub-task prompts (025.1).
// One row per parent phase-run (createCheckpoint only INSERTs, so a re-decomposed
// parent can accumulate >1 row — latest-wins on recovery).
export const FANOUT_CHECKPOINT_LABEL = (parentRunId: string): string =>
  `fanout:${parentRunId}`

// The checkpoint label for an `on_each_subtask` consumer's per-child instances
// (025.2). APPEND-ONLY — one row per triggered instance, keyed by the consumer's
// top-level (container) phase-run id; recovery unions all rows for a label.
export const EACH_SUBTASK_CHECKPOINT_LABEL = (containerRunId: string): string =>
  `eachsubtask:${containerRunId}`

// The state persisted in a fan-out parent's checkpoint (plan 025.1).
export interface FanoutCheckpointState {
  parentPhaseRunId: string
  subtasks: Array<{ phaseRunId: string; prompt: string }>
}

// The state persisted per `on_each_subtask` instance (plan 025.2). One row per
// triggered instance; recovery unions all rows for a container's label.
export interface EachSubtaskCheckpointState {
  // The consumer phase's top-level (container) phase-run id.
  containerPhaseRunId: string
  // The source fan-out child whose completion triggered this instance.
  sourceChildRunId: string
  // The created consumer instance's phase-run id.
  instanceRunId: string
  // The instance's kickoff briefing (persisted so resume needn't rebuild it).
  // Optional — absent when no prompt builder was injected (the run phase then
  // builds a generic kickoff from the graph).
  prompt?: string
}
