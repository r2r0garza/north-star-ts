import type { AgentDefinition } from "../agent/agents/types"
import { getDb } from "../db/connection"
import * as initiatives from "../db/repositories/initiatives"
import * as playbooks from "../db/repositories/playbooks"
import * as processes from "../db/repositories/processes"
import { getTask, updateTask } from "../db/repositories/tasks"
import { getWorkspace } from "../db/repositories/workspaces"
import type {
  Initiative,
  MissionControlRunLink,
  PlaybookAltitude,
  PlaybookHookName,
  PlaybookRun,
  PlaybookWithHooks,
  ProcessRun,
  SeatBindingsSnapshot,
  SliceProof,
  WorkSlice,
} from "../db/types"
import { ensureDefaultPlaybook } from "./playbook-defaults"
import {
  decideProof,
  DEFAULT_MAX_PROOF_REVISIONS,
  parseProofSubmission,
} from "./proof"
import { collectSeatRoles, resolveSeatBindings } from "./seat-resolver"
import {
  renderIntentChain,
  renderSliceObjective,
  sliceCriteria,
} from "./slice-objective"

// Slice execution (plan 106.3). Starts a slice's playbook as a Process run with
// frozen seat bindings, then maps the run's terminal state onto the slice
// exactly once. Mission/initiative hooks (hook-runner.ts) launch through the
// same path. v1 is single-flight: one playbook run at a time per workspace.

export const DEFAULT_MAX_SLICE_ATTEMPTS = 3

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"])

export interface SliceRunnerDeps {
  startProcessRun(input: {
    processId: string
    sourceConversationId: null
    objective: string
    workspacePath: string
    seatBindings: SeatBindingsSnapshot
    missionControl: MissionControlRunLink
    title: string
  }): Promise<ProcessRun>
  // Abort a Process run's backing task (runner.cancel).
  cancelTask(taskId: string): void
  loadAgents(workspace: string): Promise<AgentDefinition[]>
  // The provider a worker would run on for an account selection (null = the
  // global default). Autonomous CLI providers run their own agent loop without
  // North Star's tools, so they cannot call record_proof.
  workerProvider?(accountId: string | null): string | null
}

const CLI_PROVIDERS: Record<string, string> = {
  claude_code: "Claude Code",
  codex_cli: "Codex CLI",
}

export interface LaunchRequest {
  initiative: Initiative
  missionId: string | null
  slice: WorkSlice | null
  playbook: PlaybookWithHooks
  hook: PlaybookHookName
  podKey: string | null
  objective: string
  intentChain: string
  title: string
  // Runs inside the launch transaction, after the playbook run exists.
  onLaunch?: (playbookRun: PlaybookRun) => void
}

function budget(initiative: Initiative, key: string, fallback: number): number {
  const value = initiative.budgets?.[key]
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : fallback
}

export function maxSliceAttempts(initiative: Initiative): number {
  return budget(initiative, "maxSliceAttempts", DEFAULT_MAX_SLICE_ATTEMPTS)
}

export function maxProofRevisions(initiative: Initiative): number {
  return budget(initiative, "maxProofRevisions", DEFAULT_MAX_PROOF_REVISIONS)
}

export function initiativeWorkspacePath(initiative: Initiative): string {
  const path = initiative.workspaceId
    ? getWorkspace(initiative.workspaceId)?.path
    : undefined
  if (!path)
    throw new Error(
      "Choose a workspace for this initiative before running its playbooks."
    )
  return path
}

export function assertInitiativeRunnable(initiative: Initiative): void {
  if (initiative.status !== "active")
    throw new Error("Start the initiative before running its playbooks.")
  if (!initiative.rigSnapshot)
    throw new Error("This initiative has no rig snapshot; reseat it first.")
}

// The playbook for an altitude: the container's own choice when it names one at
// the right altitude, else the default for that altitude.
export function playbookFor(
  altitude: PlaybookAltitude,
  ...candidateIds: Array<string | null | undefined>
): PlaybookWithHooks {
  for (const id of candidateIds) {
    if (!id) continue
    const playbook = playbooks.getPlaybook(id)
    if (playbook?.altitude === altitude) return playbook
  }
  return ensureDefaultPlaybook(altitude)
}

// The playbook run occupying this initiative's workspace, if any. Two
// initiatives sharing one folder share the single-flight slot too.
export function activePlaybookRunForWorkspace(
  initiative: Initiative
): PlaybookRun | null {
  for (const run of playbooks.listPlaybookRuns({ status: "running" })) {
    if (run.initiativeId === initiative.id) return run
    const other = initiatives.getInitiative(run.initiativeId)
    if (
      initiative.workspaceId &&
      other?.workspaceId === initiative.workspaceId
    )
      return run
  }
  return null
}

function describeRun(run: PlaybookRun): string {
  if (run.sliceId) {
    const slice = initiatives.getSlice(run.sliceId)
    return slice ? `slice ${slice.key}` : "a slice"
  }
  return `the ${run.hook.replace(/_/g, " ")} hook`
}

export class SliceRunner {
  constructor(private readonly deps: SliceRunnerDeps) {}

  // ── launching ─────────────────────────────────────────────────────────────

  async launch(request: LaunchRequest): Promise<PlaybookRun> {
    const { initiative, playbook, hook } = request
    const workspacePath = initiativeWorkspacePath(initiative)
    const busy = activePlaybookRunForWorkspace(initiative)
    if (busy)
      throw new Error(
        `Only one playbook run can use this workspace at a time, and ${describeRun(busy)} is still running. Wait for it or cancel it.`
      )
    const hookRow = playbook.hooks.find((h) => h.hook === hook)
    if (!hookRow)
      throw new Error(
        `The "${playbook.name}" playbook's ${hook.replace(/_/g, " ")} hook is empty, so there is nothing to run.`
      )
    const graph = processes.getProcessGraph(hookRow.processId)
    if (!graph || graph.phases.length === 0)
      throw new Error(
        `The "${playbook.name}" playbook's ${hook.replace(/_/g, " ")} hook has no steps.`
      )

    // Resolve every seat role BEFORE anything starts: a missing role fails
    // here, naming it, with no run and no worker.
    const seatBindings = resolveSeatBindings({
      rig: initiative.rigSnapshot!,
      podKey: request.podKey,
      roles: collectSeatRoles(graph, processes.getProcessGraph),
      agents: await this.deps.loadAgents(workspacePath),
      intentChain: request.intentChain,
    })

    if (request.slice) this.assertProofStepCanRecord(graph, seatBindings)

    const playbookRun = getDb().transaction(() => {
      // Re-check under the write lock: another launch may have raced us
      // across the await above.
      if (activePlaybookRunForWorkspace(initiative))
        throw new Error(
          "Another playbook run started in this workspace. Wait for it or cancel it."
        )
      const created = playbooks.createPlaybookRun({
        playbookId: playbook.id,
        hook,
        initiativeId: initiative.id,
        missionId: request.missionId,
        sliceId: request.slice?.id ?? null,
      })
      request.onLaunch?.(created)
      return created
    })()

    try {
      const processRun = await this.deps.startProcessRun({
        processId: hookRow.processId,
        sourceConversationId: null,
        objective: request.objective,
        workspacePath,
        seatBindings,
        missionControl: {
          initiativeId: initiative.id,
          missionId: request.missionId,
          sliceId: request.slice?.id ?? null,
          playbookRunId: playbookRun.id,
          hook,
        },
        title: request.title,
      })
      const linked = playbooks.updatePlaybookRun(playbookRun.id, {
        processRunId: processRun.id,
      })
      if (request.slice)
        initiatives.setSliceExecution(
          request.slice.id,
          { processRunId: processRun.id },
          "Linked the slice's Process run"
        )
      return linked
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.applyOutcome(playbookRun.id, "failed", `Could not start: ${message}`)
      throw err
    }
  }

  // A proof step on a CLI-provider seat could never call record_proof, so the
  // attempt would fail by construction. Refuse before it is spent.
  private assertProofStepCanRecord(
    graph: NonNullable<ReturnType<typeof processes.getProcessGraph>>,
    seatBindings: SeatBindingsSnapshot
  ): void {
    if (!this.deps.workerProvider) return
    for (const phase of graph.phases.filter((p) => p.proofStep)) {
      for (const agent of graph.agents.filter((a) => a.phaseId === phase.id)) {
        for (const address of agent.seatRole
          ? (seatBindings.roles[agent.seatRole] ?? [])
          : []) {
          const seat = seatBindings.seats[address]
          const accountId =
            seat?.runtime?.accountId ??
            phase.runtimeConfig?.worker?.accountId ??
            null
          const provider = this.deps.workerProvider(accountId)
          if (provider && CLI_PROVIDERS[provider])
            throw new Error(
              `The proof step "${phase.name}" runs in ${address} on ${CLI_PROVIDERS[provider]}, which cannot record a proof yet. Give that seat (or the step) a non-CLI runtime.`
            )
        }
      }
    }
  }

  // Run (or retry) a slice with its playbook.
  async startSlice(sliceId: string): Promise<PlaybookRun> {
    const slice = initiatives.getSlice(sliceId)
    if (!slice) throw new Error(`Slice not found: ${sliceId}`)
    const mission = initiatives.getMission(slice.missionId)
    if (!mission) throw new Error(`Mission not found: ${slice.missionId}`)
    const initiative = initiatives.getInitiative(mission.initiativeId)
    if (!initiative)
      throw new Error(`Initiative not found: ${mission.initiativeId}`)
    assertInitiativeRunnable(initiative)
    if (!["draft", "ready", "failed"].includes(slice.status))
      throw new Error(
        `A ${slice.status} slice cannot be run. Only draft, ready, or failed slices can start.`
      )
    const cap = maxSliceAttempts(initiative)
    if (slice.attempts >= cap)
      throw new Error(
        `Slice ${slice.key} has used all ${cap} attempts allowed by the initiative's budget.`
      )
    const blockers = initiatives
      .listEdges(mission.id)
      .filter((edge) => edge.toSliceId === slice.id)
      .map((edge) => initiatives.getSlice(edge.fromSliceId))
      .filter((dep): dep is WorkSlice => !!dep && dep.status !== "done")
    if (blockers.length)
      throw new Error(
        `Slice ${slice.key} depends on unfinished slices: ${blockers.map((b) => b.key).join(", ")}.`
      )

    const playbook = playbookFor("slice", slice.playbookId)
    return this.launch({
      initiative,
      missionId: mission.id,
      slice,
      playbook,
      hook: "run",
      podKey: slice.podKey ?? initiative.defaultPodKey,
      objective: renderSliceObjective({ initiative, mission, slice }),
      intentChain: renderIntentChain({ initiative, mission, slice }),
      title: `Slice ${slice.key}: ${slice.title}`,
      onLaunch: () => {
        initiatives.setSliceExecution(
          slice.id,
          {
            status: "running",
            attempts: slice.attempts + 1,
            proof: null,
            startedAt: Date.now(),
            finishedAt: null,
          },
          `Attempt ${slice.attempts + 1} started with the "${playbook.name}" playbook`
        )
        if (mission.status === "planned")
          initiatives.setMissionExecutionStatus(
            mission.id,
            "active",
            `Slice ${slice.key} started`
          )
      },
    })
  }

  // ── cancelling ────────────────────────────────────────────────────────────

  cancelPlaybookRun(playbookRunId: string): void {
    const playbookRun = playbooks.getPlaybookRun(playbookRunId)
    if (!playbookRun || playbookRun.status !== "running") return
    const processRun = this.processRunFor(playbookRun)
    if (!processRun) {
      this.applyOutcome(playbookRun.id, "cancelled", "Cancelled before it started")
      return
    }
    if (TERMINAL_RUN_STATUSES.has(processRun.status)) {
      this.settle(processRun.id)
      return
    }
    const task = processRun.taskId ? getTask(processRun.taskId) : undefined
    if (task) this.deps.cancelTask(task.id)
    // An in-flight task unwinds through its abort signal and settles through
    // the run-settled listener. A parked one (queued, paused at a gate,
    // interrupted) has no executor to observe the abort, so settle it here.
    const after = task ? getTask(task.id) : undefined
    if (after?.status === "running") return
    if (after && after.status !== "cancelled")
      updateTask(after.id, { status: "cancelled" })
    processes.updateProcessRun(processRun.id, {
      status: "cancelled",
      finishedAt: Date.now(),
    })
    this.settle(processRun.id)
  }

  cancelSlice(sliceId: string): void {
    const running = playbooks
      .listPlaybookRuns({ sliceId, status: "running" })
      .at(0)
    if (running) this.cancelPlaybookRun(running.id)
  }

  // ── settling ──────────────────────────────────────────────────────────────

  // Apply a terminal Process run's outcome to its playbook run (and slice).
  // Idempotent: replaying it after a crash, or from both the live listener and
  // boot reconcile, applies the outcome exactly once.
  settle(processRunId: string): void {
    const run = processes.getProcessRun(processRunId)
    const link = run?.missionControl
    if (!run || !link || !TERMINAL_RUN_STATUSES.has(run.status)) return
    const playbookRun = playbooks.getPlaybookRun(link.playbookRunId)
    if (!playbookRun || playbookRun.status !== "running") return

    if (!playbookRun.sliceId) {
      const status = run.status as "completed" | "failed" | "cancelled"
      this.applyOutcome(
        playbookRun.id,
        status,
        status === "completed" ? null : `The hook's Process run ${status}.`
      )
      return
    }

    const proof = playbookRun.proof
    if (run.status === "completed") {
      if (proof?.verdict === "accepted")
        this.applyOutcome(playbookRun.id, "completed", null)
      else
        this.applyOutcome(
          playbookRun.id,
          "failed",
          proof
            ? "The playbook finished, but its proof was rejected."
            : "The playbook finished without recording a proof."
        )
      return
    }
    this.applyOutcome(
      playbookRun.id,
      run.status as "failed" | "cancelled",
      run.status === "cancelled"
        ? "The slice run was cancelled."
        : "The slice's Process run failed."
    )
  }

  private applyOutcome(
    playbookRunId: string,
    status: "completed" | "failed" | "cancelled",
    reason: string | null
  ): void {
    getDb().transaction(() => {
      if (!playbooks.finishPlaybookRun(playbookRunId, status, reason)) return
      const playbookRun = playbooks.getPlaybookRun(playbookRunId)!
      if (!playbookRun.sliceId) return
      const slice = initiatives.getSlice(playbookRun.sliceId)
      if (!slice || !["running", "proving"].includes(slice.status)) return
      // A cancelled run leaves the slice failed (and retryable) rather than
      // cancelled, which the work model treats as abandoned for good.
      initiatives.setSliceExecution(
        slice.id,
        {
          status: status === "completed" ? "done" : "failed",
          proof: playbookRun.proof ?? slice.proof,
          finishedAt: Date.now(),
        },
        reason ?? "Proof accepted; slice done"
      )
    })()
  }

  // Boot-time recovery: settle playbook runs whose Process run finished while
  // the app was down, and fail launches a crash interrupted before a Process
  // run existed. In-flight Process runs resume through the task runner.
  reconcile(): void {
    for (const playbookRun of playbooks.listPlaybookRuns({ status: "running" })) {
      const processRun = this.processRunFor(playbookRun)
      if (!processRun) {
        this.applyOutcome(
          playbookRun.id,
          "failed",
          "The app stopped before the run's Process started."
        )
        continue
      }
      if (!playbookRun.processRunId)
        playbooks.updatePlaybookRun(playbookRun.id, {
          processRunId: processRun.id,
        })
      this.settle(processRun.id)
    }
  }

  private processRunFor(playbookRun: PlaybookRun): ProcessRun | undefined {
    return playbookRun.processRunId
      ? processes.getProcessRun(playbookRun.processRunId)
      : processes.getProcessRunByPlaybookRunId(playbookRun.id)
  }
}

// ── proof recording (the record_proof tool's server side) ───────────────────

function rootRun(run: ProcessRun): ProcessRun {
  let current = run
  for (let depth = 0; current.parentPhaseRunId && depth < 16; depth++) {
    const parent = processes.getPhaseRun(current.parentPhaseRunId)
    const parentRun = parent ? processes.getProcessRun(parent.runId) : undefined
    if (!parentRun) break
    current = parentRun
  }
  return current
}

function runTree(root: ProcessRun): ProcessRun[] {
  const runs = [root]
  for (let i = 0; i < runs.length; i++)
    for (const phaseRun of processes.listPhaseRuns({ runId: runs[i].id })) {
      const child = processes.getProcessRunByParentPhaseRunId(phaseRun.id)
      if (child) runs.push(child)
    }
  return runs
}

// Seats that did build-type work in this run: every seat-bound phase-run that
// is not a proof step.
function builderAddresses(root: ProcessRun): string[] {
  const addresses = new Set<string>()
  for (const run of runTree(root)) {
    const proofPhases = new Set(
      (run.processId ? processes.listPhases(run.processId) : [])
        .filter((phase) => phase.proofStep)
        .map((phase) => phase.id)
    )
    for (const phaseRun of processes.listPhaseRuns({ runId: run.id }))
      if (phaseRun.seatAddress && !proofPhases.has(phaseRun.phaseId))
        addresses.add(phaseRun.seatAddress)
  }
  return [...addresses]
}

// Deterministic command phases arrive with plan 104. Until then no phase
// qualifies, so a builder can never verify its own slice.
function isCommandPhase(): boolean {
  return false
}

export type RecordProofResult =
  | { ok: true; status: "accepted" | "rejected"; proof: SliceProof; message: string }
  | { ok: false; code: string; message: string }

export function recordSliceProof(input: {
  processRunId: string
  processPhaseRunId: string
  args: Record<string, unknown>
}): RecordProofResult {
  const run = processes.getProcessRun(input.processRunId)
  const phaseRun = processes.getPhaseRun(input.processPhaseRunId)
  if (!run || !phaseRun)
    return { ok: false, code: "unavailable", message: "This run is no longer available." }
  const root = rootRun(run)
  const link = root.missionControl
  if (!link?.sliceId)
    return {
      ok: false,
      code: "unavailable",
      message: "record_proof is only available inside a Mission Control slice run.",
    }
  const phase = processes.getPhase(phaseRun.phaseId)
  if (!phase?.proofStep)
    return {
      ok: false,
      code: "not_proof_step",
      message: "Only the playbook's proof step may record the slice proof.",
    }
  const verifier = phaseRun.seatAddress
    ? root.seatBindings?.seats[phaseRun.seatAddress]
    : undefined
  if (!verifier)
    return {
      ok: false,
      code: "no_verifier_seat",
      message: "The proof step must run in a Mission Control seat so the verifier is known.",
    }
  const slice = initiatives.getSlice(link.sliceId)
  const initiative = initiatives.getInitiative(link.initiativeId)
  const playbookRun = playbooks.getPlaybookRun(link.playbookRunId)
  if (!slice || !initiative || !playbookRun)
    return { ok: false, code: "unavailable", message: "The slice is no longer available." }
  if (playbookRun.status !== "running")
    return { ok: false, code: "run_finished", message: "This slice run has already finished." }

  const criteria = sliceCriteria(slice)
  const submission = parseProofSubmission(input.args, criteria)
  if (typeof submission === "string")
    return { ok: false, code: "bad_args", message: submission }

  const decision = decideProof({
    submission,
    criteria,
    verifier,
    builderAddresses: builderAddresses(root),
    isCommandPhase,
    playbookRun,
    processRunId: root.id,
    maxProofRevisions: maxProofRevisions(initiative),
  })
  switch (decision.kind) {
    case "invalid":
      return { ok: false, code: "proof_rejected_by_rules", message: decision.message }
    case "already_accepted":
      return {
        ok: false,
        code: "already_accepted",
        message: "This slice's proof is already accepted and frozen. Do not record it again.",
      }
    case "revisions_exhausted":
      return { ok: false, code: "revisions_exhausted", message: decision.message }
  }

  getDb().transaction(() => {
    playbooks.updatePlaybookRun(playbookRun.id, {
      proof: decision.proof,
      proofRevisions: decision.proofRevisions,
    })
    const current = initiatives.getSlice(slice.id)!
    initiatives.setSliceExecution(
      slice.id,
      {
        proof: decision.proof,
        ...(current.status === "running" ? { status: "proving" as const } : {}),
      },
      `Proof ${decision.proof.verdict} by ${verifier.address}`,
      verifier.address
    )
  })()

  const accepted = decision.proof.verdict === "accepted"
  return {
    ok: true,
    status: decision.proof.verdict,
    proof: decision.proof,
    message: accepted
      ? "Proof accepted and frozen. Summarize your verification and finish."
      : decision.exhausted
        ? "Proof recorded as rejected. No revisions remain this attempt, so the slice will fail with this proof attached."
        : `Proof recorded as rejected. It may be revised ${maxProofRevisions(initiative) - decision.proofRevisions} more time(s) this attempt after the issues are fixed.`,
  }
}
