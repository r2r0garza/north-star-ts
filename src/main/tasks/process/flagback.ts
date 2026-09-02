import { getDb } from "../../db/connection"
import * as processes from "../../db/repositories/processes"
import { deleteApprovalsForPhaseRuns } from "../../db/repositories/approvals"
import {
  createCheckpoint,
  deleteCheckpoint,
  listCheckpoints,
} from "../../db/repositories/task-checkpoints"
import {
  FANOUT_CHECKPOINT_LABEL,
  EACH_SUBTASK_CHECKPOINT_LABEL,
  SUBPROCESS_CHECKPOINT_LABEL,
  type FanoutCheckpointState,
} from "./checkpoints"
import { MAX_PROCESS_DEPTH } from "./scheduler"
import type {
  ProcessGraph,
  ProcessPhase,
  ProcessPhaseRun,
  ProcessRun,
} from "../../db/types"

// Cross-phase flag-back reset (plan 031.2). A phase-worker flagged a defect an
// earlier phase owns; this module resolves the target, computes the transitive
// downstream, and resets the target + downstream to `pending` so the scheduler
// re-walks. ONE reset code path, called by both the autonomous scheduler route
// and the human-confirm service route.
//
// Cooperates with the container/checkpoint machinery:
//  - Resetting a CONTAINER to re-decompose/re-trigger must DELETE its stale
//    fanout:/eachsubtask: checkpoints (the scheduler rebuilds decomposedParents/
//    triggeredPairs from them on every entry) + its child rows, else it won't
//    re-run cleanly.
//  - A per-child reset (a single fan-out sub-task) resets only that child + the
//    on_each_subtask instances descended from it (via source_child_run_id),
//    leaving sibling children/instances untouched.

// ── target resolution ─────────────────────────────────────────────────────────

export interface FlagTarget {
  targetPhaseId: string
  // The specific fan-out sub-task (child run) targeted, when the flag is per-child;
  // undefined = the whole phase.
  targetChildRunId?: string
}

export interface ResolveError {
  error: string
}

// Build forward adjacency (fromPhaseId → toPhaseId[]) from the graph's edges.
function forwardAdjacency(graph: ProcessGraph): Map<string, string[]> {
  const adj = new Map<string, string[]>()
  for (const e of graph.edges) {
    const list = adj.get(e.fromPhaseId) ?? []
    list.push(e.toPhaseId)
    adj.set(e.fromPhaseId, list)
  }
  return adj
}

// The set of phase ids strictly UPSTREAM of `phaseId` (its transitive ancestors),
// via reverse-edge BFS. A visited-set guards against a mis-authored cycle (the DAG
// has no cycle guard). Excludes `phaseId` itself.
export function ancestorsOf(graph: ProcessGraph, phaseId: string): Set<string> {
  const incoming = new Map<string, string[]>()
  for (const e of graph.edges) {
    const list = incoming.get(e.toPhaseId) ?? []
    list.push(e.fromPhaseId)
    incoming.set(e.toPhaseId, list)
  }
  const seen = new Set<string>()
  const queue = [...(incoming.get(phaseId) ?? [])]
  while (queue.length) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    for (const src of incoming.get(id) ?? [])
      if (!seen.has(src)) queue.push(src)
  }
  return seen
}

// The transitive forward closure of `phaseId` (itself + everything downstream),
// via forward-edge BFS with a mandatory visited-set (no cycle guard on the DAG).
export function downstreamClosure(
  graph: ProcessGraph,
  phaseId: string
): Set<string> {
  const adj = forwardAdjacency(graph)
  const seen = new Set<string>([phaseId])
  const queue = [phaseId]
  while (queue.length) {
    const id = queue.shift()!
    for (const to of adj.get(id) ?? [])
      if (!seen.has(to)) {
        seen.add(to)
        queue.push(to)
      }
  }
  return seen
}

// The per-child downstream: on_each_subtask consumer INSTANCES transitively
// descended from `childRunId` via source_child_run_id. Follows the lineage forward
// (I1 → its Test instance T1 → any instance consuming T1, …). Excludes the seed.
// Visited-set guards against pathological self-reference.
export function descendantChildRuns(
  runId: string,
  childRunId: string
): ProcessPhaseRun[] {
  const all = processes.listPhaseRuns({ runId })
  const bySource = new Map<string, ProcessPhaseRun[]>()
  for (const pr of all) {
    if (!pr.sourceChildRunId) continue
    const list = bySource.get(pr.sourceChildRunId) ?? []
    list.push(pr)
    bySource.set(pr.sourceChildRunId, list)
  }
  const out: ProcessPhaseRun[] = []
  const seen = new Set<string>([childRunId])
  const queue = [childRunId]
  while (queue.length) {
    const id = queue.shift()!
    for (const inst of bySource.get(id) ?? [])
      if (!seen.has(inst.id)) {
        seen.add(inst.id)
        out.push(inst)
        queue.push(inst.id)
      }
  }
  return out
}

// Resolve a flag's target from what the flagging worker named. `targetPhaseKey`
// must be a transitive UPSTREAM ancestor of the flagging phase, and its phase-run
// must be COMPLETED (settled context — v1 rejects flagging a still-running phase).
// Sub-task resolution:
//  - flagging run is an on_each_subtask INSTANCE (has sourceChildRunId) targeting
//    its source phase → target that specific child (the engine knows which; the
//    agent named no index).
//  - `subtaskIndex` (1-based, from a `key#N` name) → the Nth child of that fan-out
//    parent's top-level run.
export function resolveTarget(
  graph: ProcessGraph,
  runId: string,
  flaggingPhaseRun: ProcessPhaseRun,
  input: { targetPhaseKey: string; subtaskIndex?: number }
): FlagTarget | ResolveError {
  const target = graph.phases.find((p) => p.key === input.targetPhaseKey)
  if (!target) return { error: `unknown phase key "${input.targetPhaseKey}"` }
  if (target.id === flaggingPhaseRun.phaseId)
    return { error: "a phase cannot flag itself" }

  const ancestors = ancestorsOf(graph, flaggingPhaseRun.phaseId)
  if (!ancestors.has(target.id))
    return {
      error: `"${input.targetPhaseKey}" is not an upstream phase of the flagging phase; you may only flag work that ran before you`,
    }

  const topLevel = processes
    .listPhaseRuns({ runId, phaseId: target.id })
    .find((pr) => pr.parentId === null)
  if (!topLevel)
    return { error: `no run found for phase "${input.targetPhaseKey}"` }
  if (topLevel.status !== "completed")
    return {
      error: `phase "${input.targetPhaseKey}" has not completed; only a completed phase can be flagged`,
    }

  // Per-child: the flagging instance consumed one specific child of the target.
  if (
    flaggingPhaseRun.sourceChildRunId &&
    isSourcePhaseOfInstance(runId, flaggingPhaseRun, target.id)
  ) {
    return {
      targetPhaseId: target.id,
      targetChildRunId: flaggingPhaseRun.sourceChildRunId,
    }
  }

  // Per-child by explicit index (a non-fan-out consumer naming `key#N`).
  if (input.subtaskIndex !== undefined) {
    if (!target.fanOut)
      return { error: `phase "${input.targetPhaseKey}" is not a fan-out phase` }
    const children = orderedChildren(runId, topLevel.id)
    const child = children[input.subtaskIndex - 1]
    if (!child)
      return {
        error: `sub-task ${input.subtaskIndex} does not exist in "${input.targetPhaseKey}"`,
      }
    return { targetPhaseId: target.id, targetChildRunId: child.id }
  }

  return { targetPhaseId: target.id }
}

// Is `target` the source phase whose child the flagging INSTANCE consumes? (i.e.
// the instance's sourceChildRunId is a child of `targetPhaseId`'s top-level run.)
function isSourcePhaseOfInstance(
  runId: string,
  instance: ProcessPhaseRun,
  targetPhaseId: string
): boolean {
  if (!instance.sourceChildRunId) return false
  const child = processes.getPhaseRun(instance.sourceChildRunId)
  return child?.phaseId === targetPhaseId
}

// Children of a container's top-level run, in creation order (stable positional
// index for `key#N` targeting). listPhaseRuns has no ORDER BY, so sort by id is
// not chronological — instead rely on the fanout: checkpoint's recorded order
// when available, else fall back to the DB row order.
function orderedChildren(
  runId: string,
  parentRunId: string
): ProcessPhaseRun[] {
  return processes.listPhaseRuns({ runId, parentId: parentRunId })
}

// ── the reset ───────────────────────────────────────────────────────────────

const toPending = {
  status: "pending" as const,
  error: null,
  failure: null,
  startedAt: null,
  finishedAt: null,
  outputIdentity: null,
}

// Is a phase a container (fan-out parent or on_each_subtask consumer of a fan-out
// source)? Mirrors the scheduler/service predicate.
export function isContainer(graph: ProcessGraph, phaseId: string): boolean {
  const phase = graph.phases.find((p) => p.id === phaseId)
  if (!phase) return false
  if (phase.fanOut) return true
  const phasesById = new Map(graph.phases.map((p) => [p.id, p]))
  return graph.edges.some(
    (e) =>
      e.toPhaseId === phaseId &&
      e.trigger === "on_each_subtask" &&
      phasesById.get(e.fromPhaseId)?.fanOut === true
  )
}

// Delete every fanout:/eachsubtask: checkpoint row for a container's top-level run
// so the scheduler re-decomposes / re-triggers it clean (it rebuilds
// decomposedParents/triggeredPairs from these on entry). `childPhaseRunIds` are the
// container's child rows about to be deleted (plan 038.3): a per-fan-out-child
// sub-process wrote a subprocess:<childRunId> accelerator checkpoint per child, so
// clear those too or a re-decomposed container would re-attach to stale nested runs.
function clearContainerCheckpoints(
  taskId: string,
  containerRunId: string,
  childPhaseRunIds: string[] = []
): void {
  const fanoutLabel = FANOUT_CHECKPOINT_LABEL(containerRunId)
  const eachLabel = EACH_SUBTASK_CHECKPOINT_LABEL(containerRunId)
  const subprocessLabels = new Set(
    childPhaseRunIds.map((id) => SUBPROCESS_CHECKPOINT_LABEL(id))
  )
  for (const cp of listCheckpoints(taskId))
    if (
      cp.label === fanoutLabel ||
      cp.label === eachLabel ||
      (cp.label !== null && subprocessLabels.has(cp.label))
    )
      deleteCheckpoint(cp.id)
}

// Reset a whole CONTAINER top-level run: delete its children (parent_id cascade)
// + its checkpoints, then set it pending so it re-decomposes / re-triggers fresh.
export function resetContainerWhole(
  taskId: string,
  runId: string,
  containerRun: ProcessPhaseRun,
  reworkNote: string | null
): void {
  const children = processes.listPhaseRuns({
    runId,
    parentId: containerRun.id,
  })
  for (const child of children) processes.deletePhaseRun(child.id)
  clearContainerCheckpoints(
    taskId,
    containerRun.id,
    children.map((c) => c.id)
  )
  processes.updatePhaseRun(containerRun.id, {
    ...toPending,
    reworkNote,
    reworkRound: containerRun.reworkRound + 1,
    validatorRound: 0,
    outputIdentity: null,
  })
}

// Reset a plain (non-container) phase-run in place (the requestChanges write shape).
export function resetPlain(
  phaseRun: ProcessPhaseRun,
  reworkNote: string | null
): void {
  processes.updatePhaseRun(phaseRun.id, {
    ...toPending,
    reworkNote,
    reworkRound: phaseRun.reworkRound + 1,
    validatorRound: 0,
    outputIdentity: null,
  })
}

export interface ApplyFlagBackInput {
  taskId: string
  runId: string
  graph: ProcessGraph
  target: FlagTarget
  reason: string
}

// Apply a resolved flag: reset the target (+ downstream) to pending in ONE
// transaction. The scheduler re-walks after this commits.
export function applyFlagBack(input: ApplyFlagBackInput): void {
  const tx = getDb().transaction(() => {
    if (input.target.targetChildRunId) applyPerChild(input)
    else applyWholePhase(input)
  })
  tx()
}

// PER-CHILD: reset only the flagged fan-out sub-task child; DELETE the
// on_each_subtask instances descended from it (they'll be recreated fresh by the
// normal trigger machinery once the reworked child re-completes, with a prompt
// built from its NEW output). Reopen the affected containers. Leave sibling
// children/instances (I2/I3, T2/T3) untouched. A downstream on_complete aggregator
// that read the whole batch can't partially re-run — reset it whole.
//
// Why DELETE (not reset) the descendant instances: the scheduler rebuilds its
// per-child idempotency (`triggeredPairs`) from the eachsubtask: checkpoints on
// entry. Deleting the instance row + its checkpoint row drops the (sourceChild →
// consumer) pair, so when the reworked child re-completes triggerEachSubtask mints
// a fresh instance from the child's new output. Resetting-in-place instead would
// leave the pair present AND a pending row → the child re-completes, no new
// instance is owed, and the stale-prompted pending row runs against old context.
function applyPerChild(input: ApplyFlagBackInput): void {
  const { taskId, runId, graph, target, reason } = input
  const childRunId = target.targetChildRunId!
  const child = processes.getPhaseRun(childRunId)
  if (!child) return

  // 1. Delete the descendant on_each_subtask instances (+ their checkpoint rows)
  //    FIRST, before resetting the child, so their lineage links still resolve.
  for (const inst of descendantChildRuns(runId, childRunId)) {
    if (inst.parentId) {
      deleteInstanceCheckpointRow(taskId, inst.parentId, inst.id)
      reopenContainer(inst.parentId)
    }
    processes.deletePhaseRun(inst.id)
  }

  // 2. Reset the flagged child; re-inject the reason into its stored sub-task
  //    prompt (children run subtaskPrompt verbatim, so append a "requested changes"
  //    note via a fresh fanout: checkpoint row — latest-wins on recovery).
  processes.updatePhaseRun(childRunId, { ...toPending, outputIdentity: null })
  reinjectChildPrompt(taskId, child, reason)

  // 3. Reopen the child's container parent so the scheduler re-derives it once the
  //    child re-completes (a backward completed → running container transition).
  if (child.parentId) reopenContainer(child.parentId)

  // 4. Any NON-instance downstream (an on_complete consumer that aggregated the
  //    whole batch) can't partially re-run — reset it (and its downstream) whole.
  const targetPhase = graph.phases.find((p) => p.id === target.targetPhaseId)
  if (targetPhase) resetAggregatingDownstream(input, targetPhase)
}

// WHOLE-PHASE: reset the target phase and every phase transitively downstream.
function applyWholePhase(input: ApplyFlagBackInput): void {
  const { taskId, runId, graph, target, reason } = input
  const closure = downstreamClosure(graph, target.targetPhaseId)
  for (const phaseId of closure) {
    const topLevel = processes
      .listPhaseRuns({ runId, phaseId })
      .find((pr) => pr.parentId === null)
    if (!topLevel) continue
    const isTarget = phaseId === target.targetPhaseId
    const note = isTarget
      ? reason
      : `An upstream phase this depends on was reworked; re-check your output.`
    if (isContainer(graph, phaseId)) {
      resetContainerWhole(taskId, runId, topLevel, note)
    } else {
      resetPlain(topLevel, note)
    }
  }
}

// For a per-child target, reset any downstream phase that is NOT a per-instance
// on_each_subtask consumer (i.e. it aggregated all children) — whole, transitively.
function resetAggregatingDownstream(
  input: ApplyFlagBackInput,
  targetPhase: ProcessPhase
): void {
  const { taskId, runId, graph } = input
  const eachSubtaskConsumers = new Set(
    graph.edges
      .filter(
        (e) =>
          e.trigger === "on_each_subtask" &&
          graph.phases.find((p) => p.id === e.fromPhaseId)?.fanOut === true
      )
      .map((e) => e.toPhaseId)
  )
  const closure = downstreamClosure(graph, targetPhase.id)
  for (const phaseId of closure) {
    if (phaseId === targetPhase.id) continue
    // Per-instance consumers were already handled via descendantChildRuns.
    if (eachSubtaskConsumers.has(phaseId)) continue
    const topLevel = processes
      .listPhaseRuns({ runId, phaseId })
      .find((pr) => pr.parentId === null)
    if (!topLevel) continue
    const note = `An upstream sub-task was reworked; re-check your output.`
    if (isContainer(graph, phaseId))
      resetContainerWhole(taskId, runId, topLevel, note)
    else resetPlain(topLevel, note)
  }
}

// Reopen a container (completed → running) so the scheduler's derive step re-owns
// it once its reset child re-completes. Only meaningful if it's currently terminal.
function reopenContainer(containerRunId: string): void {
  const container = processes.getPhaseRun(containerRunId)
  if (!container) return
  if (container.status === "running") return
  processes.updatePhaseRun(containerRunId, {
    status: "running",
    error: null,
    failure: null,
    finishedAt: null,
  })
}

// Append a "requested changes" note to a fan-out child's stored prompt so its
// re-dispatch (which runs subtaskPrompt verbatim) carries the feedback. Written as
// a fresh fanout: checkpoint row for the child's parent (latest-wins on recovery).
function reinjectChildPrompt(
  taskId: string,
  child: ProcessPhaseRun,
  reason: string
): void {
  if (!child.parentId) return
  // Find the child's current stored prompt from the latest fanout: checkpoint.
  const label = FANOUT_CHECKPOINT_LABEL(child.parentId)
  let priorPrompt = ""
  for (const cp of listCheckpoints(taskId)) {
    if (cp.label !== label) continue
    const state = cp.state as FanoutCheckpointState
    const found = state.subtasks?.find((s) => s.phaseRunId === child.id)
    if (found) priorPrompt = found.prompt // ASC order → last wins
  }
  const newPrompt =
    `${priorPrompt}\n\n## Requested changes\nA later phase reviewed your sub-task and asked for changes:\n\n${reason}`.trim()
  createCheckpoint({
    taskId,
    label,
    state: {
      parentPhaseRunId: child.parentId,
      subtasks: [{ phaseRunId: child.id, prompt: newPrompt }],
    } satisfies FanoutCheckpointState,
  })
}

// Delete the specific eachsubtask: checkpoint row for one instance, so on re-run
// buildEachSubtaskPrompt regenerates its briefing from the reworked child's fresh
// output (rather than resurrecting the stale stored prompt). Other instances'
// rows for the same container are left intact.
function deleteInstanceCheckpointRow(
  taskId: string,
  containerRunId: string,
  instanceRunId: string
): void {
  const label = EACH_SUBTASK_CHECKPOINT_LABEL(containerRunId)
  for (const cp of listCheckpoints(taskId)) {
    if (cp.label !== label) continue
    const state = cp.state as { instanceRunId?: string }
    if (state.instanceRunId === instanceRunId) deleteCheckpoint(cp.id)
  }
}

// ── recursive run reset (plan 038.2) ──────────────────────────────────────────
//
// Reset a run's top-level phase-run frontier, descending through any nested
// SUB-PROCESS phase-runs into their child runs (linked by parent_phase_run_id).
// ONE code path shared by two callers:
//  - restartRun (mode "frontier"): retry a FAILED run — reset only failed/cancelled
//    phase-runs. A sub-process phase-run whose CHILD run failed must reset the
//    child's own failed frontier too (038.1 re-attaches to the child but never
//    reset it, so the child re-failed immediately — the 038.2 bug this fixes).
//  - requestChanges on a sub-process phase (mode "whole"): re-drive the WHOLE child
//    run with feedback — reset ALL of the child's phase-runs so it re-executes from
//    the top, injecting the feedback into the child graph's entry phases.
//
// Transaction-agnostic: the caller wraps it in its own getDb().transaction() (both
// restartRun and requestChanges already open one). The container predicate is
// rebuilt per child graph (each recursion uses its own `graph`), and recursion is
// bounded by MAX_PROCESS_DEPTH as a backstop against a mis-authored cycle.
export type ResetMode = "frontier" | "whole"

export interface ResetRunRecursiveInput {
  taskId: string
  run: ProcessRun
  graph: ProcessGraph
  mode: ResetMode
  // For mode "whole": the feedback note. Injected as reworkNote onto the ENTRY
  // phases (no incoming edges) so their re-run kickoff surfaces it.
  note?: string | null
  depth?: number
}

const resettable = (s: string): boolean => s === "failed" || s === "cancelled"
const frontierToPending = {
  status: "pending" as const,
  taskId: null,
  error: null,
  failure: null,
  startedAt: null,
  finishedAt: null,
}

export function resetRunRecursive(input: ResetRunRecursiveInput): void {
  const { taskId, run, graph, mode, note = null } = input
  const depth = input.depth ?? 0
  const phasesById = new Map(graph.phases.map((p) => [p.id, p]))

  // Entry phases (no incoming edge) carry the feedback note on a whole reset.
  const hasIncoming = new Set(graph.edges.map((e) => e.toPhaseId))

  for (const pr of processes.listPhaseRuns({ runId: run.id, parentId: null })) {
    const phase = phasesById.get(pr.phaseId)

    // A sub-process phase-run (checked BEFORE the frontier-resettable skip): a run
    // that failed INSIDE the nested run leaves THIS phase-run `running` (the child
    // driveRun threw, so runSubProcessWithRetry never settled it) while the CHILD
    // run + its own phases are `failed`. Frontier restart must reset the child's
    // failed frontier — so recurse whenever the child run isn't completed, not just
    // when this phase-run is itself resettable.
    if (phase?.subprocessId) {
      const childRun = processes.getProcessRunByParentPhaseRunId(pr.id)
      const childNeedsReset = !!childRun && childRun.status !== "completed"
      if (mode === "whole" || resettable(pr.status) || childNeedsReset) {
        if (mode === "whole") {
          const isEntry = !hasIncoming.has(phase.id)
          resetPlain(pr, isEntry ? note : null)
        } else {
          processes.updatePhaseRun(pr.id, frontierToPending)
        }
        recurseIntoChild(taskId, pr, mode, note, depth)
      }
      continue
    }

    if (mode === "frontier" && !resettable(pr.status)) continue

    // A container (fan-out parent / on_each_subtask consumer) WITH children.
    if (phase && isContainer(graph, phase.id)) {
      const children = processes.listPhaseRuns({
        runId: run.id,
        parentId: pr.id,
      })
      if (children.length > 0) {
        if (mode === "whole") {
          const isEntry = !hasIncoming.has(phase.id)
          resetContainerWhole(taskId, run.id, pr, isEntry ? note : null)
        } else {
          // Frontier: re-own via derivation; re-dispatch only broken children.
          processes.updatePhaseRun(pr.id, {
            status: "running",
            error: null,
            failure: null,
            finishedAt: null,
          })
          for (const child of children)
            if (resettable(child.status))
              processes.updatePhaseRun(child.id, frontierToPending)
        }
        continue
      }
      // No children (decompose/trigger itself failed) → fall through to re-decompose.
    }

    // A plain phase-run.
    if (mode === "whole") {
      const isEntry = phase ? !hasIncoming.has(phase.id) : false
      resetPlain(pr, isEntry ? note : null)
    } else {
      processes.updatePhaseRun(pr.id, frontierToPending)
    }
  }
}

// Whole-reset the child run beneath a sub-process phase-run (plan 038.2), for
// requestChanges on a sub-process phase: re-drive the entire nested run with the
// feedback note injected into its entry phases. Reuses recurseIntoChild (flips the
// child run running, clears its stale gate approvals, recurses into grandchildren).
// No-op when the phase never spawned a child (getProcessRunByParentPhaseRunId none).
export function resetSubProcessChild(
  taskId: string,
  parentPhaseRun: ProcessPhaseRun,
  note: string | null
): void {
  recurseIntoChild(taskId, parentPhaseRun, "whole", note, 0)
}

// Descend into the child run beneath a sub-process phase-run. Skips cleanly when
// the child run or its definition is gone (the phase failed before spawning a child,
// or the sub-process definition was deleted). Flips the child run `running` so the
// scheduler re-derives it, clears the reworked child subtree's stale gate approval
// rows (so needsGate's count-based re-detection restarts from zero), then recurses.
function recurseIntoChild(
  taskId: string,
  phaseRun: ProcessPhaseRun,
  mode: ResetMode,
  note: string | null,
  depth: number
): void {
  if (depth + 1 >= MAX_PROCESS_DEPTH) return
  const childRun = processes.getProcessRunByParentPhaseRunId(phaseRun.id)
  if (!childRun?.processId) return
  const childGraph = processes.getProcessGraph(childRun.processId)
  if (!childGraph) return

  processes.updateProcessRun(childRun.id, {
    status: "running",
    finishedAt: null,
  })

  // Clear the child subtree's stale gate/validator approval rows (R2) so a
  // re-completed child gate re-fires. Only needed on a whole reset (frontier keeps
  // completed phases + their settled gates intact).
  if (mode === "whole") {
    const childPhaseRunIds = processes
      .listPhaseRuns({ runId: childRun.id })
      .map((pr) => pr.id)
    deleteApprovalsForPhaseRuns(taskId, childPhaseRunIds)
  }

  resetRunRecursive({
    taskId,
    run: childRun,
    graph: childGraph,
    mode,
    note,
    depth: depth + 1,
  })
}
