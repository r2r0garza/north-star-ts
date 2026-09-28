import type { AgentDefinition } from "../agent/agents/types"
import type { WorktreeEnvironment } from "./worktree-env"
import { getDb } from "../db/connection"
import * as features from "../db/repositories/features"
import * as playbooks from "../db/repositories/playbooks"
import * as processes from "../db/repositories/processes"
import { getTask, updateTask } from "../db/repositories/tasks"
import { getWorkspace } from "../db/repositories/workspaces"
import type {
  Feature,
  MissionControlRunLink,
  PlaybookAltitude,
  PlaybookHookName,
  PlaybookRun,
  PlaybookWithHooks,
  ProcessRun,
  SeatBindingsSnapshot,
  UserStoryProof,
  UserStory,
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
  renderUserStoryObjective,
  userStoryCriteria,
} from "./user-story-objective"
import {
  touchHintsOverlap,
  withRunsLastEdges,
} from "../../shared/mission-control/waves"
import {
  DEFAULT_MAX_CONCURRENT_USER_STORIES,
  type IsolatedUserStoryWorkspace,
  type MilestoneIntegration,
} from "./integration"

// User story execution (plan 106.3). Starts a user story's playbook as a Process run with
// frozen seat bindings, then maps the run's terminal state onto the user story
// exactly once. Milestone/feature hooks (hook-runner.ts) launch through the
// same path.
//
// Isolation (plan 106.5): in a git workspace each user story attempt runs in its
// own worktree, so user stories run in parallel up to the feature's
// maxConcurrentSlices budget, and a finished user story waits in the milestone's
// merge queue. Runs in the workspace itself (hooks, and every run in a
// non-git workspace) stay single-flight.

export const DEFAULT_MAX_USER_STORY_ATTEMPTS = 3

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"])

export interface UserStoryRunnerDeps {
  startProcessRun(input: {
    processId: string
    sourceConversationId: null
    objective: string
    workspacePath: string
    workingDirectory: string | null
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
  // A cancelled run stops its feature's Comms (plan 106.4): queued mail
  // expires and pending wakes are cancelled.
  onCancelled?(featureId: string): void
  // Worktrees and the merge queue (plan 106.5). Without it every run is
  // single-flight in the workspace, as in 106.3.
  integration?: MilestoneIntegration
}

const CLI_PROVIDERS: Record<string, string> = {
  claude_code: "Claude Code",
  codex_cli: "Codex CLI",
}

export interface LaunchRequest {
  feature: Feature
  milestoneId: string | null
  userStory: UserStory | null
  playbook: PlaybookWithHooks
  hook: PlaybookHookName
  podKey: string | null
  objective: string | ((isolated: IsolatedWorkspace | null) => string)
  intentChain: string
  title: string
  // Roles a rig may fill with another role's seats (integrator → lead).
  roleFallbacks?: Record<string, string>
  // Give the run its own worktree (user story runs). Called after every check
  // passes; null means the workspace can't isolate and the run is
  // single-flight in place.
  isolate?: () => Promise<IsolatedUserStoryWorkspace | null>
  // A worktree prepared by the caller (conflict resolution).
  isolated?: IsolatedWorkspace
  // Runs inside the launch transaction, after the playbook run exists.
  onLaunch?: (
    playbookRun: PlaybookRun,
    isolated: IsolatedWorkspace | null
  ) => void
}

export interface IsolatedWorkspace {
  workspacePath: string
  worktreePath: string
  environment?: WorktreeEnvironment | null
  branch?: string
  baseOid?: string
  integrationBranch?: string
  discard?: () => Promise<void>
}

function budget(feature: Feature, key: string, fallback: number): number {
  const value = feature.budgets?.[key]
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : fallback
}

export function maxUserStoryAttempts(feature: Feature): number {
  return budget(
    feature,
    "maxUserStoryAttempts",
    DEFAULT_MAX_USER_STORY_ATTEMPTS
  )
}

export function maxProofRevisions(feature: Feature): number {
  return budget(feature, "maxProofRevisions", DEFAULT_MAX_PROOF_REVISIONS)
}

export function maxConcurrentUserStories(feature: Feature): number {
  return Math.max(
    1,
    budget(
      feature,
      "maxConcurrentUserStories",
      DEFAULT_MAX_CONCURRENT_USER_STORIES
    )
  )
}

export function featureWorkspacePath(feature: Feature): string {
  const path = feature.workspaceId
    ? getWorkspace(feature.workspaceId)?.path
    : undefined
  if (!path)
    throw new Error(
      "Choose a workspace for this feature before running its playbooks."
    )
  return path
}

export function assertFeatureRunnable(feature: Feature): void {
  if (feature.status !== "active")
    throw new Error("Start the feature before running its playbooks.")
  if (!feature.rigSnapshot)
    throw new Error("This feature has no rig snapshot; reseat it first.")
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

// The playbook run occupying this feature's workspace, if any. Two
// features sharing one folder share the single-flight slot too. Runs in
// their own worktree (106.5) don't occupy it.
export function activePlaybookRunForWorkspace(
  feature: Feature
): PlaybookRun | null {
  for (const run of playbooks.listPlaybookRuns({ status: "running" })) {
    if (run.worktreePath) continue
    if (run.featureId === feature.id) return run
    const other = features.getFeature(run.featureId)
    if (feature.workspaceId && other?.workspaceId === feature.workspaceId)
      return run
  }
  return null
}

// User story runs building in their own worktrees for this feature.
function isolatedUserStoryRuns(feature: Feature): PlaybookRun[] {
  return playbooks
    .listPlaybookRuns({ featureId: feature.id, status: "running" })
    .filter((run) => run.worktreePath && run.hook === "run")
}

function describeRun(run: PlaybookRun): string {
  if (run.userStoryId) {
    const userStory = features.getUserStory(run.userStoryId)
    return userStory ? `user story ${userStory.key}` : "a user story"
  }
  return `the ${run.hook.replace(/_/g, " ")} hook`
}

export class UserStoryRunner {
  constructor(private readonly deps: UserStoryRunnerDeps) {}

  // ── launching ─────────────────────────────────────────────────────────────

  async launch(request: LaunchRequest): Promise<PlaybookRun> {
    const { feature, playbook, hook } = request
    const workspacePath = featureWorkspacePath(feature)
    const wantsIsolation = !!request.isolate || !!request.isolated
    const assertSlot = (isolated: boolean) => {
      if (isolated) {
        if (!request.userStory || hook !== "run") return
        const cap = maxConcurrentUserStories(feature)
        if (isolatedUserStoryRuns(feature).length >= cap)
          throw new Error(
            `The feature's budget allows ${cap} running user stories at once. Wait for one to finish or raise maxConcurrentSlices.`
          )
        return
      }
      const busy = activePlaybookRunForWorkspace(feature)
      if (busy)
        throw new Error(
          `Only one playbook run can use this workspace at a time, and ${describeRun(busy)} is still running. Wait for it or cancel it.${request.userStory ? " (User stories run in parallel only in a git workspace.)" : ""}`
        )
    }
    if (!wantsIsolation) assertSlot(false)
    else if (request.userStory && hook === "run") assertSlot(true)
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
      rig: feature.rigSnapshot!,
      podKey: request.podKey,
      roles: collectSeatRoles(graph, processes.getProcessGraph),
      agents: await this.deps.loadAgents(workspacePath),
      intentChain: request.intentChain,
      roleFallbacks: request.roleFallbacks,
    })

    if (request.userStory) this.assertProofStepCanRecord(graph, seatBindings)

    // The worktree is created last, once nothing else can refuse the launch.
    const isolated: IsolatedWorkspace | null =
      request.isolated ?? (request.isolate ? await request.isolate() : null)
    if (request.isolate && !isolated) assertSlot(false)

    let playbookRun: PlaybookRun
    try {
      playbookRun = getDb().transaction(() => {
        // Re-check under the write lock: another launch may have raced us
        // across the awaits above.
        assertSlot(!!isolated)
        const created = playbooks.createPlaybookRun({
          playbookId: playbook.id,
          hook,
          featureId: feature.id,
          milestoneId: request.milestoneId,
          userStoryId: request.userStory?.id ?? null,
          worktreePath: isolated?.worktreePath ?? null,
        })
        request.onLaunch?.(created, isolated)
        return created
      })()
    } catch (err) {
      if (!request.isolated) await isolated?.discard?.().catch(() => {})
      throw err
    }

    try {
      const processRun = await this.deps.startProcessRun({
        processId: hookRow.processId,
        sourceConversationId: null,
        objective:
          typeof request.objective === "function"
            ? request.objective(isolated)
            : request.objective,
        // The run belongs to the feature's workspace; an isolated one works
        // in its worktree, which is never registered as a workspace.
        workspacePath,
        workingDirectory: isolated?.workspacePath ?? null,
        seatBindings,
        missionControl: {
          featureId: feature.id,
          milestoneId: request.milestoneId,
          userStoryId: request.userStory?.id ?? null,
          playbookRunId: playbookRun.id,
          hook,
        },
        title: request.title,
      })
      const linked = playbooks.updatePlaybookRun(playbookRun.id, {
        processRunId: processRun.id,
      })
      if (request.userStory)
        features.setUserStoryExecution(
          request.userStory.id,
          { processRunId: processRun.id },
          "Linked the user story's Process run"
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

  // Run (or retry) a user story with its playbook. `allowTouchOverlap` runs it
  // even though a user story with overlapping touch hints is still building.
  // `note` travels to this attempt's workers (a lead's retry note, 106.6), and
  // `actor` attributes the start in the revision log.
  async startUserStory(
    userStoryId: string,
    options: { allowTouchOverlap?: boolean; note?: string; actor?: string } = {}
  ): Promise<PlaybookRun> {
    const userStory = features.getUserStory(userStoryId)
    if (!userStory) throw new Error(`User story not found: ${userStoryId}`)
    const milestone = features.getMilestone(userStory.milestoneId)
    if (!milestone)
      throw new Error(`Milestone not found: ${userStory.milestoneId}`)
    const feature = features.getFeature(milestone.featureId)
    if (!feature) throw new Error(`Feature not found: ${milestone.featureId}`)
    assertFeatureRunnable(feature)
    if (!["draft", "ready", "failed"].includes(userStory.status))
      throw new Error(
        `A ${userStory.status} user story cannot be run. Only draft, ready, or failed user stories can start.`
      )
    const cap = maxUserStoryAttempts(feature)
    if (userStory.attempts >= cap)
      throw new Error(
        `User story ${userStory.key} has used all ${cap} attempts allowed by the feature's budget.`
      )
    const siblings = features.listUserStories(milestone.id)
    const blockers = withRunsLastEdges(
      siblings.map((s) => ({
        id: s.id,
        status: s.status,
        runsLast: s.spec.runsLast,
      })),
      features.listEdges(milestone.id)
    )
      .filter((edge) => edge.toUserStoryId === userStory.id)
      .map((edge) => features.getUserStory(edge.fromUserStoryId))
      .filter((dep): dep is UserStory => !!dep && dep.status !== "done")
    if (blockers.length)
      throw new Error(
        `User story ${userStory.key} depends on unmerged user stories: ${blockers.map((b) => b.key).join(", ")}. A user story starts once its predecessors are done${milestone.integrationBranch ? " and merged into the integration branch" : ""}.`
      )
    // Overlapping touch hints serialize by default (decision 7): two user stories
    // editing the same area in parallel is how merge conflicts are made. The
    // feature's "parallel" policy, or a one-off "Run anyway", opts out.
    if (
      !options.allowTouchOverlap &&
      feature.drive.overlapPolicy !== "parallel"
    ) {
      const overlapping = features
        .listUserStories(milestone.id)
        .filter(
          (other) =>
            other.id !== userStory.id &&
            ["running", "proving"].includes(other.status) &&
            touchHintsOverlap(userStory.spec.touchHints, other.spec.touchHints)
        )
      if (overlapping.length)
        throw new Error(
          `touch_overlap: User story ${userStory.key}'s touch hints overlap ${overlapping.map((o) => o.key).join(", ")}, which is still building. Running both at once risks a merge conflict.`
        )
    }

    const playbook = playbookFor("user_story", userStory.playbookId)
    const attempt = userStory.attempts + 1
    const integration = this.deps.integration
    return this.launch({
      feature,
      milestoneId: milestone.id,
      userStory,
      playbook,
      hook: "run",
      podKey: userStory.podKey ?? feature.defaultPodKey,
      objective: (isolated) =>
        renderUserStoryObjective({
          feature,
          milestone,
          userStory,
          attemptNote: options.note
            ? { attempt, by: options.actor ?? "user", text: options.note }
            : null,
          workspace:
            isolated?.branch && isolated.integrationBranch
              ? {
                  branch: isolated.branch,
                  integrationBranch: isolated.integrationBranch,
                  environment: isolated.environment ?? null,
                }
              : null,
        }),
      intentChain: renderIntentChain({ feature, milestone, userStory }),
      title: `User story ${userStory.key}: ${userStory.title}`,
      isolate: integration
        ? () =>
            integration.prepareUserStoryRun({
              feature,
              milestone,
              userStory,
              attempt,
            })
        : undefined,
      onLaunch: (_run, isolated) => {
        features.setUserStoryExecution(
          userStory.id,
          {
            status: "running",
            attempts: attempt,
            proof: null,
            startedAt: Date.now(),
            finishedAt: null,
            ...(isolated
              ? {
                  branch: isolated.branch ?? null,
                  worktreePath: isolated.worktreePath,
                  baseOid: isolated.baseOid ?? null,
                }
              : {}),
          },
          `Attempt ${attempt} started with the "${playbook.name}" playbook${isolated?.branch ? ` on ${isolated.branch}` : ""}${options.note ? ` — note: ${options.note}` : ""}`,
          options.actor ?? "mission-control"
        )
        if (milestone.status === "planned")
          features.setMilestoneExecutionStatus(
            milestone.id,
            "active",
            `User story ${userStory.key} started`
          )
      },
    })
  }

  // ── cancelling ────────────────────────────────────────────────────────────

  cancelPlaybookRun(playbookRunId: string): void {
    const playbookRun = playbooks.getPlaybookRun(playbookRunId)
    if (!playbookRun || playbookRun.status !== "running") return
    this.deps.onCancelled?.(playbookRun.featureId)
    const processRun = this.processRunFor(playbookRun)
    if (!processRun) {
      this.applyOutcome(
        playbookRun.id,
        "cancelled",
        "Cancelled before it started"
      )
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

  cancelUserStory(userStoryId: string): void {
    const running = playbooks
      .listPlaybookRuns({ userStoryId, status: "running" })
      .at(0)
    if (running) this.cancelPlaybookRun(running.id)
  }

  // ── settling ──────────────────────────────────────────────────────────────

  // Apply a terminal Process run's outcome to its playbook run (and user story).
  // Idempotent: replaying it after a crash, or from both the live listener and
  // boot reconcile, applies the outcome exactly once.
  settle(processRunId: string): void {
    const run = processes.getProcessRun(processRunId)
    const link = run?.missionControl
    if (!run || !link || !TERMINAL_RUN_STATUSES.has(run.status)) return
    const playbookRun = playbooks.getPlaybookRun(link.playbookRunId)
    if (!playbookRun || playbookRun.status !== "running") return

    if (!playbookRun.userStoryId) {
      const status = run.status as "completed" | "failed" | "cancelled"
      this.applyOutcome(
        playbookRun.id,
        status,
        status === "completed" ? null : `The hook's Process run ${status}.`
      )
      return
    }

    const proof = playbookRun.proof
    // A conflict resolution (106.5): finish the run, then let the integration
    // service commit the merge (accepted re-verification) or escalate.
    if (playbookRun.hook === "after_each_user_story") {
      const status = run.status as "completed" | "failed" | "cancelled"
      this.applyOutcome(
        playbookRun.id,
        status === "completed" && proof?.verdict !== "accepted"
          ? "failed"
          : status,
        status !== "completed"
          ? `The resolution run ${status}.`
          : proof?.verdict === "accepted"
            ? null
            : proof
              ? "The re-verification proof was rejected."
              : "The resolution finished without re-verifying the user story."
      )
      this.deps.integration?.onResolutionSettled(playbookRun.id)
      return
    }
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
    const failure = run.status === "failed" ? processRunFailure(run.id) : null
    this.applyOutcome(
      playbookRun.id,
      run.status as "failed" | "cancelled",
      run.status === "cancelled"
        ? "The user story run was cancelled."
        : failure
          ? `The user story's Process run failed. ${failure.reason}`
          : "The user story's Process run failed."
    )
  }

  private applyOutcome(
    playbookRunId: string,
    status: "completed" | "failed" | "cancelled",
    reason: string | null
  ): void {
    const settled = getDb().transaction(() => {
      if (!playbooks.finishPlaybookRun(playbookRunId, status, reason))
        return null
      const playbookRun = playbooks.getPlaybookRun(playbookRunId)!
      if (!playbookRun.userStoryId || playbookRun.hook !== "run") return null
      const userStory = features.getUserStory(playbookRun.userStoryId)
      if (!userStory || !["running", "proving"].includes(userStory.status))
        return null
      // Built in its own worktree: the user story is done only once it merges.
      if (
        status === "completed" &&
        playbookRun.worktreePath &&
        this.deps.integration
      ) {
        this.deps.integration.enqueueAcceptedUserStory(userStory, playbookRun)
        return { userStory, merge: true }
      }
      // A cancelled run leaves the user story failed (and retryable) rather than
      // cancelled, which the work model treats as abandoned for good.
      features.setUserStoryExecution(
        userStory.id,
        {
          status: status === "completed" ? "done" : "failed",
          proof: playbookRun.proof ?? userStory.proof,
          finishedAt: Date.now(),
        },
        reason ?? "Proof accepted; user story done"
      )
      return { userStory, merge: false }
    })()
    const integration = this.deps.integration
    if (!settled || !integration) return
    if (settled.merge) void integration.kick(settled.userStory.milestoneId)
    else {
      if (status !== "completed")
        void integration
          .releaseUserStoryWorktree(settled.userStory.id)
          .catch((err) => console.warn("[integration] release worktree:", err))
      integration.advanceMilestone(settled.userStory.milestoneId)
    }
  }

  // Boot-time recovery: settle playbook runs whose Process run finished while
  // the app was down, and fail launches a crash interrupted before a Process
  // run existed. In-flight Process runs resume through the task runner.
  reconcile(): void {
    for (const playbookRun of playbooks.listPlaybookRuns({
      status: "running",
    })) {
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

// ── failure summary ─────────────────────────────────────────────────────────

export interface ProcessRunFailure {
  // One line naming the failed phase and its actual error, for the user
  // story's outcome and the lead's decision.
  reason: string
  // The model request failed (output limit, provider errors), not the user
  // story's own work: retrying is the fix, not a plan change.
  infrastructure: boolean
}

const MAX_FAILURE_MESSAGE = 300

// The most recently failed phase of a Process run, or null when no phase
// recorded a failure.
export function processRunFailure(
  processRunId: string
): ProcessRunFailure | null {
  const failed = processes
    .listPhaseRuns({ runId: processRunId })
    .filter(
      (phaseRun) =>
        phaseRun.status === "failed" && (phaseRun.failure || phaseRun.error)
    )
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0]
  if (!failed) return null
  const phaseName =
    processes.getPhase(failed.phaseId)?.name ?? failed.title ?? "unknown"
  const stage = failed.failure?.stage
  let message = (failed.failure?.message ?? failed.error ?? "")
    .trim()
    .replace(/\s+/g, " ")
  if (message.length > MAX_FAILURE_MESSAGE)
    message = `${message.slice(0, MAX_FAILURE_MESSAGE - 1)}…`
  return {
    reason: `Phase "${phaseName}" failed${stage ? ` (${stage.replace(/_/g, " ")})` : ""}: ${message || "no error recorded"}`,
    infrastructure: stage === "model_request",
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
// qualifies, so a builder can never verify its own user story.
function isCommandPhase(): boolean {
  return false
}

export type RecordProofResult =
  | {
      ok: true
      status: "accepted" | "rejected"
      proof: UserStoryProof
      message: string
    }
  | { ok: false; code: string; message: string }

export function recordUserStoryProof(input: {
  processRunId: string
  processPhaseRunId: string
  args: Record<string, unknown>
}): RecordProofResult {
  const run = processes.getProcessRun(input.processRunId)
  const phaseRun = processes.getPhaseRun(input.processPhaseRunId)
  if (!run || !phaseRun)
    return {
      ok: false,
      code: "unavailable",
      message: "This run is no longer available.",
    }
  const root = rootRun(run)
  const link = root.missionControl
  if (!link?.userStoryId)
    return {
      ok: false,
      code: "unavailable",
      message:
        "record_proof is only available inside a Mission Control user story run.",
    }
  const phase = processes.getPhase(phaseRun.phaseId)
  if (!phase?.proofStep)
    return {
      ok: false,
      code: "not_proof_step",
      message:
        "Only the playbook's proof step may record the user story proof.",
    }
  const verifier = phaseRun.seatAddress
    ? root.seatBindings?.seats[phaseRun.seatAddress]
    : undefined
  if (!verifier)
    return {
      ok: false,
      code: "no_verifier_seat",
      message:
        "The proof step must run in a Mission Control seat so the verifier is known.",
    }
  const userStory = features.getUserStory(link.userStoryId)
  const feature = features.getFeature(link.featureId)
  const playbookRun = playbooks.getPlaybookRun(link.playbookRunId)
  if (!userStory || !feature || !playbookRun)
    return {
      ok: false,
      code: "unavailable",
      message: "The user story is no longer available.",
    }
  if (playbookRun.status !== "running")
    return {
      ok: false,
      code: "run_finished",
      message: "This user story run has already finished.",
    }

  const criteria = userStoryCriteria(userStory)
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
    maxProofRevisions: maxProofRevisions(feature),
  })
  switch (decision.kind) {
    case "invalid":
      return {
        ok: false,
        code: "proof_rejected_by_rules",
        message: decision.message,
      }
    case "already_accepted":
      return {
        ok: false,
        code: "already_accepted",
        message:
          "This user story's proof is already accepted and frozen. Do not record it again.",
      }
    case "revisions_exhausted":
      return {
        ok: false,
        code: "revisions_exhausted",
        message: decision.message,
      }
  }

  getDb().transaction(() => {
    playbooks.updatePlaybookRun(playbookRun.id, {
      proof: decision.proof,
      proofRevisions: decision.proofRevisions,
    })
    const current = features.getUserStory(userStory.id)!
    features.setUserStoryExecution(
      userStory.id,
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
        ? "Proof recorded as rejected. No revisions remain this attempt, so the user story will fail with this proof attached."
        : `Proof recorded as rejected. It may be revised ${maxProofRevisions(feature) - decision.proofRevisions} more time(s) this attempt after the issues are fixed.`,
  }
}
