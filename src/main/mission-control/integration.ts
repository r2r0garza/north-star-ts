import { randomBytes } from "crypto"
import { existsSync } from "fs"
import { readdir, rm } from "fs/promises"
import path from "path"
import ignore from "ignore"
import { repositoryDelegationLeases } from "../agent/subagents/repository-lease"
import {
  deleteMissionControlBranch,
  removeWorktree,
  runGit,
} from "../agent/subagents/worktrees"
import { getDb } from "../db/connection"
import * as initiatives from "../db/repositories/initiatives"
import * as mergeQueue from "../db/repositories/merge-queue"
import * as playbooks from "../db/repositories/playbooks"
import { getWorkspace, upsertHiddenWorkspace } from "../db/repositories/workspaces"
import type {
  Initiative,
  MergePolicyMode,
  MergeQueueEntry,
  Mission,
  MissionLanding,
  PlaybookRun,
  SliceProof,
  WorkSlice,
} from "../db/types"
import { deriveWaves } from "../../shared/mission-control/waves"
import {
  changedFiles,
  commitWorktreeChanges,
  createSliceWorktree,
  deleteMergedBranches,
  findSliceMerge,
  finalizeResolution,
  ghAvailable,
  integrationBranchName,
  isAncestor,
  landingSummary,
  landLocally,
  listBranches,
  mergeSlice,
  openPullRequest,
  prepareResolution,
  pushRemote,
  repositoryRoot,
  revParse,
  sliceBranchPrefix,
  startIntegrationBranch,
  workspaceSubpath,
  worktreeDiff,
  type LandingSummary,
} from "./mission-git"

// Mission integration (plan 106.5). Deterministic, restart-safe service that:
//
// - starts a mission's integration branch (clean preflight, recorded base),
// - gives each slice attempt its own branch + worktree off the integration head,
// - merges finished slices through a serialized, dependency-ordered queue,
// - hands conflicts to the mission's after_each_slice hook (integrator seat),
//   which must re-verify the slice before the merge commits, or escalates,
// - lands the mission per its merge policy, and
// - cleans up its own worktrees and `mc/…` branches.
//
// Only conflict resolution involves an agent. Everything here is git and
// SQLite; the queue rows are the durable state, so a restart resumes where the
// last completed step left off.

export const DEFAULT_MAX_CONCURRENT_SLICES = 3
// Automatic integrator attempts per queue entry before the user is asked.
const MAX_AUTO_RESOLUTIONS = 2
const LEASE_RETRY_MS = 30_000

export type WorkspaceMode =
  | { mode: "git"; root: string }
  | { mode: "single_flight"; reason: string }

export interface IsolatedSliceWorkspace {
  // Where the run's workers work: the worktree, or the workspace's folder
  // inside it when the workspace is a subfolder of the repository.
  workspacePath: string
  worktreePath: string
  branch: string
  baseOid: string
  integrationBranch: string
  discard(): Promise<void>
}

export interface ResolutionLaunchInput {
  initiative: Initiative
  mission: Mission
  slice: WorkSlice
  workspacePath: string
  worktreePath: string
  files: string[]
  // Records the launched playbook run on the queue entry inside the launch
  // transaction, so the run can't settle before the entry knows about it.
  onLaunch(run: PlaybookRun): void
}

export interface IntegrationDeps {
  // Where Mission Control keeps worktrees (app data, never the workspace).
  worktreeRoot(): string
  startResolution?(input: ResolutionLaunchInput): Promise<PlaybookRun>
  notifyUser?(title: string, body: string): void
  onChanged?(initiativeId: string): void
  // Tests shorten the retry when the repository is busy.
  leaseRetryMs?: number
}

export interface PolicyOption {
  available: boolean
  // open_pr is hidden entirely when the repository has no remote.
  visible: boolean
  reason?: string
}

export interface MissionIntegrationStatus {
  missionId: string
  workspace: WorkspaceMode | { mode: "none"; reason: string }
  integrationBranch: string | null
  baseRef: string | null
  baseOid: string | null
  policy: MergePolicyMode
  policyLocked: boolean
  policies: Record<MergePolicyMode, PolicyOption>
  queue: MergeQueueEntry[]
  summary: LandingSummary | null
  landing: MissionLanding | null
}

export interface SliceWorkspaceInfo {
  branch: string | null
  worktreePath: string | null
  workspacePath: string | null
  baseOid: string | null
  exists: boolean
  integrationBranch: string | null
}

function suffix(): string {
  return randomBytes(3).toString("hex")
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Touched files that none of the slice's touch hints cover: the drift signal
// 106.8 consumes. A slice without hints declared nothing, so nothing drifts.
export function filesOutsideHints(files: string[], hints: string[]): string[] {
  const patterns = hints.map((h) => h.trim().replace(/^\.?\/+/, "")).filter(Boolean)
  if (!patterns.length) return []
  const matcher = ignore().add(patterns)
  return files.filter((file) => !matcher.ignores(file))
}

function proofSummary(proof: SliceProof | null): string {
  if (!proof) return "No proof recorded."
  const verifier =
    proof.verifiedBy.kind === "seat"
      ? proof.verifiedBy.address
      : `command ${proof.verifiedBy.phaseKey}`
  return [
    `Proof ${proof.verdict} by ${verifier}:`,
    ...proof.criteria.map(
      (c) => `- ${c.id} ${c.status}: ${c.evidence.replace(/\s+/g, " ").slice(0, 200)}`
    ),
  ].join("\n")
}

export function sliceMergeMessage(input: {
  slice: WorkSlice
  proof: SliceProof | null
  playbookRunId: string | null
  resolvedBy?: string | null
}): string {
  return [
    `slice ${input.slice.key}: ${input.slice.title}`,
    "",
    proofSummary(input.proof),
    "",
    `Mission-Control-Slice: ${input.slice.id}`,
    `Mission-Control-Proof: ${input.playbookRunId ?? "none"}`,
    ...(input.resolvedBy ? [`Mission-Control-Resolved-By: ${input.resolvedBy}`] : []),
  ].join("\n")
}

function workspacePathOf(initiative: Initiative): string | null {
  return initiative.workspaceId
    ? (getWorkspace(initiative.workspaceId)?.path ?? null)
    : null
}

function context(missionId: string) {
  const mission = initiatives.getMission(missionId)
  if (!mission) throw new Error(`Mission not found: ${missionId}`)
  const initiative = initiatives.getInitiative(mission.initiativeId)
  if (!initiative) throw new Error(`Initiative not found: ${mission.initiativeId}`)
  return { mission, initiative }
}

export class MissionIntegration {
  private readonly chains = new Map<string, Promise<void>>()
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly prepares = new Map<string, Promise<unknown>>()
  // The boot sweep: queue work and new worktrees wait for it, so it can never
  // remove a worktree that is being created or merged in.
  private ready: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(private readonly deps: IntegrationDeps) {}

  stop(): void {
    this.stopped = true
    for (const timer of this.retryTimers.values()) clearTimeout(timer)
    this.retryTimers.clear()
  }

  // Resolves once every queued merge the service knows about has settled
  // (tests and shutdown).
  async idle(): Promise<void> {
    while (true) {
      const pending = [...this.chains.values()]
      if (!pending.length) return
      await Promise.all(pending)
      if ([...this.chains.values()].every((chain) => pending.includes(chain))) return
    }
  }

  private changed(initiativeId: string): void {
    this.deps.onChanged?.(initiativeId)
  }

  // ── mode ──────────────────────────────────────────────────────────────────

  async workspaceMode(initiative: Initiative): Promise<WorkspaceMode> {
    const workspace = workspacePathOf(initiative)
    if (!workspace)
      return { mode: "single_flight", reason: "The initiative has no workspace yet." }
    const root = await repositoryRoot(workspace)
    return root
      ? { mode: "git", root }
      : {
          mode: "single_flight",
          reason:
            "The workspace isn't a git repository, so slices can't get their own worktrees. They run one at a time in the workspace.",
        }
  }

  // ── slice worktrees ───────────────────────────────────────────────────────

  // Start the mission's integration branch if needed, then create this slice
  // attempt's branch + worktree from the integration head. Null means the
  // workspace isn't a git repository: the slice runs single-flight in place.
  async prepareSliceRun(input: {
    initiative: Initiative
    mission: Mission
    slice: WorkSlice
    attempt: number
  }): Promise<IsolatedSliceWorkspace | null> {
    const workspace = workspacePathOf(input.initiative)
    if (!workspace) return null
    const mode = await this.workspaceMode(input.initiative)
    if (mode.mode !== "git") return null
    await this.ready
    const mission = await this.ensureMissionStarted(input.mission.id, workspace)
    const root = mission.repoRoot!
    const directory = path.join(
      this.deps.worktreeRoot(),
      input.initiative.id,
      `${input.slice.key}-${input.attempt}-${suffix()}`
    )
    const created = await createSliceWorktree({
      root,
      integrationBranch: mission.integrationBranch!,
      sliceKey: input.slice.key,
      attempt: input.attempt,
      directory,
    })
    const workspacePath = path.join(directory, await workspaceSubpath(root, workspace))
    upsertHiddenWorkspace(workspacePath, `${input.slice.key} (slice worktree)`)
    return {
      workspacePath,
      worktreePath: directory,
      branch: created.branch,
      baseOid: created.baseOid,
      integrationBranch: mission.integrationBranch!,
      discard: async () => {
        await removeWorktree(root, directory)
        await deleteMissionControlBranch(root, created.branch)
      },
    }
  }

  // Idempotent and serialized per mission: concurrent first slices both see
  // one integration branch.
  private async ensureMissionStarted(missionId: string, workspace: string): Promise<Mission> {
    const previous = this.prepares.get(missionId) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(async () => {
        const { mission, initiative } = context(missionId)
        if (mission.integrationBranch && mission.repoRoot) return mission
        const branch = integrationBranchName(initiative.key, mission.key)
        const started = await startIntegrationBranch({ workspace, branch })
        return initiatives.setMissionIntegration(missionId, {
          integrationBranch: branch,
          baseRef: started.baseRef,
          baseOid: started.baseOid,
          repoRoot: started.root,
        })
      })
    this.prepares.set(missionId, next)
    try {
      return await next
    } finally {
      if (this.prepares.get(missionId) === next) this.prepares.delete(missionId)
    }
  }

  // A slice attempt that ended without an accepted proof gives its worktree
  // back. Its branch stays for inspection until initiative cleanup.
  async releaseSliceWorktree(sliceId: string): Promise<void> {
    const slice = initiatives.getSlice(sliceId)
    if (!slice?.worktreePath) return
    const { mission } = context(slice.missionId)
    if (["running", "proving", "integrating"].includes(slice.status)) return
    if (mission.repoRoot) await removeWorktree(mission.repoRoot, slice.worktreePath)
    initiatives.setSliceExecution(
      slice.id,
      { worktreePath: null },
      "Removed the attempt's worktree (branch kept)"
    )
  }

  info(sliceId: string): SliceWorkspaceInfo {
    const slice = initiatives.getSlice(sliceId)
    if (!slice) throw new Error(`Slice not found: ${sliceId}`)
    const { mission } = context(slice.missionId)
    const run = playbooks
      .listPlaybookRuns({ sliceId })
      .find((r) => r.hook === "run" && r.worktreePath === slice.worktreePath)
    const workspacePath =
      slice.worktreePath && run?.processRunId
        ? (processWorkspace(run.processRunId) ?? slice.worktreePath)
        : slice.worktreePath
    return {
      branch: slice.branch,
      worktreePath: slice.worktreePath,
      workspacePath,
      baseOid: slice.baseOid,
      exists: !!slice.worktreePath && existsSync(slice.worktreePath),
      integrationBranch: mission.integrationBranch,
    }
  }

  // The slice's changes against the integration commit it started from,
  // including uncommitted edits while its worktree exists.
  async sliceDiff(sliceId: string): Promise<{ diff: string; truncated: boolean }> {
    const slice = initiatives.getSlice(sliceId)
    if (!slice?.baseOid || !slice.branch) return { diff: "", truncated: false }
    const { mission } = context(slice.missionId)
    const root = mission.repoRoot
    if (!root) return { diff: "", truncated: false }
    const limit = 512 * 1024
    if (slice.worktreePath && existsSync(slice.worktreePath))
      return worktreeDiff(slice.worktreePath, slice.baseOid, limit)
    const diff = await runGit(root, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      `${slice.baseOid}..refs/heads/${slice.branch}`,
    ]).catch(() => "")
    return diff.length > limit
      ? { diff: diff.slice(0, limit), truncated: true }
      : { diff, truncated: false }
  }

  // ── the queue ─────────────────────────────────────────────────────────────

  // Inside the slice runner's settle transaction: an accepted slice in its
  // own worktree waits in the merge queue instead of being done.
  enqueueAcceptedSlice(slice: WorkSlice, playbookRun: PlaybookRun): MergeQueueEntry {
    initiatives.setSliceExecution(
      slice.id,
      { status: "integrating", proof: playbookRun.proof ?? slice.proof },
      "Proof accepted; queued to merge into the integration branch"
    )
    return mergeQueue.enqueueMerge({
      missionId: slice.missionId,
      sliceId: slice.id,
      playbookRunId: playbookRun.id,
      proofAcceptedAt: playbookRun.proof?.acceptedAt ?? Date.now(),
    })
  }

  // Serialize work on one mission's queue. Returns the chain's promise.
  kick(missionId: string): Promise<void> {
    const timer = this.retryTimers.get(missionId)
    if (timer) {
      clearTimeout(timer)
      this.retryTimers.delete(missionId)
    }
    return this.enqueueWork(missionId, () => this.drain(missionId))
  }

  private enqueueWork(missionId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.chains.get(missionId) ?? this.ready
    const next = previous
      .then(() => (this.stopped ? undefined : work()))
      .catch((error) => console.error(`[integration] mission ${missionId}:`, error))
    this.chains.set(missionId, next)
    void next.finally(() => {
      if (this.chains.get(missionId) === next) this.chains.delete(missionId)
    })
    return next
  }

  private scheduleRetry(missionId: string): void {
    if (this.stopped || this.retryTimers.has(missionId)) return
    const timer = setTimeout(() => {
      this.retryTimers.delete(missionId)
      void this.kick(missionId)
    }, this.deps.leaseRetryMs ?? LEASE_RETRY_MS)
    timer.unref?.()
    this.retryTimers.set(missionId, timer)
  }

  // Merge queued entries one at a time until none is ready.
  private async drain(missionId: string): Promise<void> {
    await this.recoverInterrupted(missionId)
    for (let guard = 0; guard < 1000; guard++) {
      const entry = this.nextQueued(missionId)
      if (!entry) break
      const result = await this.mergeEntry(entry)
      if (result === "stop") break
    }
    this.advanceMission(missionId)
  }

  // Dependency order first (wave level), then proof-accepted time.
  private nextQueued(missionId: string): MergeQueueEntry | null {
    const queued = mergeQueue.listMergeEntries({ missionId, statuses: ["queued"] })
    if (!queued.length) return null
    const slices = initiatives.listSlices(missionId)
    const levels = deriveWaves(slices, initiatives.listEdges(missionId)).levels
    const position = new Map(slices.map((s) => [s.id, s.position]))
    return [...queued].sort(
      (a, b) =>
        (levels.get(a.sliceId) ?? 0) - (levels.get(b.sliceId) ?? 0) ||
        a.proofAcceptedAt - b.proofAcceptedAt ||
        (position.get(a.sliceId) ?? 0) - (position.get(b.sliceId) ?? 0)
    )[0]
  }

  // Any `merging` row at the start of a drain is stale: merges only happen
  // inside this chain. The integration branch moved with a compare-and-swap,
  // so the slice either is in it (finish the bookkeeping) or isn't (requeue).
  private async recoverInterrupted(missionId: string): Promise<void> {
    const stale = mergeQueue.listMergeEntries({ missionId, statuses: ["merging"] })
    if (!stale.length) return
    const { mission } = context(missionId)
    for (const entry of stale) {
      const root = mission.repoRoot
      const head = root ? await revParse(root, `refs/heads/${mission.integrationBranch}`) : null
      if (root && head && entry.sliceHead && (await isAncestor(root, entry.sliceHead, head))) {
        const commit = await findSliceMerge(root, mission.integrationBranch!, entry.sliceId)
        await this.completeMerge(entry, commit, ["merging"])
      } else {
        mergeQueue.updateMergeEntry(
          entry.id,
          { status: "queued", note: "Requeued after an interrupted merge" },
          ["merging"]
        )
      }
    }
  }

  private async mergeEntry(entry: MergeQueueEntry): Promise<"continue" | "stop"> {
    const { mission, initiative } = context(entry.missionId)
    const slice = initiatives.getSlice(entry.sliceId)
    const root = mission.repoRoot
    if (!slice || !root || !mission.integrationBranch || !slice.branch) {
      this.escalate(entry, "The slice or its integration branch is no longer available.", [
        "queued",
      ])
      return "continue"
    }
    const lease = await repositoryDelegationLeases
      .acquire(root, `Mission Control merge queue (${mission.key})`)
      .catch((error) => {
        mergeQueue.updateMergeEntry(
          entry.id,
          { note: `Waiting for the repository: ${message(error).replace(/^repository_busy:/, "")}` },
          ["queued"]
        )
        this.changed(initiative.id)
        return null
      })
    if (!lease) {
      this.scheduleRetry(mission.id)
      return "stop"
    }
    let conflict = false
    try {
      const started = mergeQueue.updateMergeEntry(
        entry.id,
        {
          status: "merging",
          attempt: entry.attempt + 1,
          startedAt: Date.now(),
          note: null,
          escalated: false,
          conflictFiles: [],
        },
        ["queued"]
      )
      if (!started) return "continue"
      this.changed(initiative.id)

      if (slice.worktreePath && existsSync(slice.worktreePath))
        await commitWorktreeChanges(
          slice.worktreePath,
          `slice ${slice.key}: ${slice.title}\n\nWork left uncommitted at proof acceptance, recorded by Mission Control.\n\nMission-Control-Slice: ${slice.id}`
        )
      const sliceHead = await revParse(root, `refs/heads/${slice.branch}`)
      if (!sliceHead) {
        this.escalate(started, `The slice branch ${slice.branch} is missing.`, ["merging"])
        return "continue"
      }
      const touched = slice.baseOid
        ? await changedFiles(root, slice.baseOid, sliceHead).catch(() => [])
        : []
      mergeQueue.updateMergeEntry(entry.id, {
        sliceHead,
        touchedFiles: touched,
        outsideHints: filesOutsideHints(touched, slice.spec.touchHints),
      })

      const playbookRun = entry.playbookRunId
        ? playbooks.getPlaybookRun(entry.playbookRunId)
        : null
      const outcome = await mergeSlice({
        root,
        integrationBranch: mission.integrationBranch,
        sliceHead,
        message: sliceMergeMessage({
          slice,
          proof: playbookRun?.proof ?? (slice.proof as SliceProof | null),
          playbookRunId: entry.playbookRunId,
        }),
        scratchDirectory: this.scratchDirectory(initiative.id, "merge"),
      })
      switch (outcome.status) {
        case "merged":
          await this.completeMerge(started, outcome.mergeCommit, ["merging"])
          return "continue"
        case "already_merged":
          await this.completeMerge(started, null, ["merging"])
          return "continue"
        case "moved":
          mergeQueue.updateMergeEntry(entry.id, { status: "queued" }, ["merging"])
          return "continue"
        case "blocked":
          this.escalate(started, outcome.reason, ["merging"])
          return "stop"
        case "conflict":
          mergeQueue.updateMergeEntry(
            entry.id,
            {
              status: "conflict",
              conflictFiles: outcome.files,
              note: `Conflicts with the integration branch in ${outcome.files.length} file(s).`,
            },
            ["merging"]
          )
          conflict = true
          return "continue"
      }
      return "continue"
    } catch (error) {
      this.escalate(entry, `The merge failed: ${message(error)}`, ["merging", "queued"])
      return "continue"
    } finally {
      repositoryDelegationLeases.release(lease)
      this.changed(initiative.id)
      // Hand the conflict to the integrator after the lease is released: the
      // resolution worktree doesn't need it, and the queue keeps moving.
      if (conflict) await this.startResolution(entry.id, false)
    }
  }

  private scratchDirectory(initiativeId: string, kind: "merge" | "land"): string {
    return path.join(this.deps.worktreeRoot(), initiativeId, `${kind}-${suffix()}`)
  }

  // A merge landed: the entry is merged, the slice done, its worktree gone.
  private async completeMerge(
    entry: MergeQueueEntry,
    mergeCommit: string | null,
    from: MergeQueueEntry["status"][]
  ): Promise<void> {
    const merged = getDb().transaction(() => {
      const updated = mergeQueue.updateMergeEntry(
        entry.id,
        {
          status: "merged",
          mergeCommit,
          finishedAt: Date.now(),
          note: mergeCommit ? null : "Nothing to merge: the slice made no changes.",
          escalated: false,
        },
        from
      )
      if (!updated) return null
      const slice = initiatives.getSlice(entry.sliceId)
      if (slice?.status === "integrating")
        initiatives.setSliceExecution(
          slice.id,
          { status: "done", finishedAt: Date.now() },
          mergeCommit
            ? `Merged into the integration branch (${mergeCommit.slice(0, 10)})`
            : "Merged into the integration branch (no changes)"
        )
      return updated
    })()
    if (!merged) return
    const { mission, initiative } = context(entry.missionId)
    const slice = initiatives.getSlice(entry.sliceId)
    if (mission.repoRoot) {
      if (slice?.worktreePath) await removeWorktree(mission.repoRoot, slice.worktreePath)
      if (merged.resolutionWorktree)
        await removeWorktree(mission.repoRoot, merged.resolutionWorktree)
    }
    if (slice?.worktreePath)
      initiatives.setSliceExecution(
        slice.id,
        { worktreePath: null },
        "Removed the merged slice's worktree"
      )
    this.changed(initiative.id)
  }

  private escalate(
    entry: MergeQueueEntry,
    note: string,
    from: MergeQueueEntry["status"][]
  ): void {
    const updated = mergeQueue.updateMergeEntry(
      entry.id,
      { status: "conflict", escalated: true, note },
      from
    )
    if (!updated) return
    const { initiative } = context(entry.missionId)
    const slice = initiatives.getSlice(entry.sliceId)
    this.deps.notifyUser?.(
      `Mission Control: slice ${slice?.key ?? ""} needs you`,
      note
    )
    this.changed(initiative.id)
  }

  // ── conflicts ─────────────────────────────────────────────────────────────

  // Run the mission's after_each_slice hook in a fresh worktree holding the
  // conflicted merge. `manual` (the user asked) skips the automatic cap.
  private async startResolution(entryId: string, manual: boolean): Promise<void> {
    const entry = mergeQueue.getMergeEntry(entryId)
    if (!entry || entry.status !== "conflict") return
    const { mission, initiative } = context(entry.missionId)
    const slice = initiatives.getSlice(entry.sliceId)
    if (!slice || !mission.repoRoot || !mission.integrationBranch || !entry.sliceHead) {
      this.escalate(entry, "The slice can't be merged: its branch or the integration branch is gone.", ["conflict"])
      return
    }
    if (!this.deps.startResolution) {
      this.escalate(entry, entry.note ?? "The merge conflicts.", ["conflict"])
      return
    }
    if (!manual && entry.resolutionAttempts >= MAX_AUTO_RESOLUTIONS) {
      this.escalate(
        entry,
        `The integrator didn't resolve the conflict after ${entry.resolutionAttempts} attempt(s). Resolve it on the slice branch and retry, run the integrator again, or abandon the slice.`,
        ["conflict"]
      )
      return
    }
    const workspace = workspacePathOf(initiative)
    const directory = path.join(
      this.deps.worktreeRoot(),
      initiative.id,
      `resolve-${slice.key}-${suffix()}`
    )
    try {
      const prepared = await prepareResolution({
        root: mission.repoRoot,
        integrationBranch: mission.integrationBranch,
        sliceHead: entry.sliceHead,
        directory,
      })
      const files = prepared.files.length ? prepared.files : entry.conflictFiles
      const workspacePath = path.join(
        directory,
        workspace ? await workspaceSubpath(mission.repoRoot, workspace) : ""
      )
      upsertHiddenWorkspace(workspacePath, `${slice.key} (merge resolution)`)
      const claimed = mergeQueue.updateMergeEntry(
        entry.id,
        {
          status: "resolving",
          escalated: false,
          conflictFiles: files,
          resolutionWorktree: directory,
          resolutionStartOid: prepared.startOid,
          resolutionAttempts: entry.resolutionAttempts + 1,
          note: "The integrator is resolving the conflict.",
        },
        ["conflict"]
      )
      if (!claimed) {
        await removeWorktree(mission.repoRoot, directory)
        return
      }
      this.changed(initiative.id)
      await this.deps.startResolution({
        initiative,
        mission,
        slice,
        workspacePath,
        worktreePath: directory,
        files,
        onLaunch: (run) => {
          mergeQueue.updateMergeEntry(entry.id, { resolutionRunId: run.id })
        },
      })
    } catch (error) {
      await removeWorktree(mission.repoRoot, directory)
      const current = mergeQueue.getMergeEntry(entry.id)
      if (current)
        this.escalate(
          current,
          `The merge conflicts in ${entry.conflictFiles.join(", ") || "some files"}, and the integrator couldn't start: ${message(error)}`,
          ["conflict", "resolving"]
        )
    }
  }

  // The resolution run settled (from SliceRunner.settle). An accepted
  // re-verification commits the merge; anything else goes to the user.
  onResolutionSettled(playbookRunId: string): void {
    const entry = mergeQueue.getMergeEntryByResolutionRun(playbookRunId)
    if (!entry || entry.status !== "resolving") return
    const run = playbooks.getPlaybookRun(playbookRunId)
    if (!run || run.status === "running") return
    void this.enqueueWork(entry.missionId, async () => {
      const current = mergeQueue.getMergeEntry(entry.id)
      if (!current || current.status !== "resolving") return
      if (run.status === "completed" && run.proof?.verdict === "accepted")
        await this.finalize(current, run)
      else {
        await this.dropResolutionWorktree(current)
        this.escalate(
          current,
          `The integrator's resolution run ${run.status}${run.outcomeReason ? `: ${run.outcomeReason}` : "."}`,
          ["resolving"]
        )
      }
      this.advanceMission(entry.missionId)
    })
  }

  private async dropResolutionWorktree(entry: MergeQueueEntry): Promise<void> {
    const { mission } = context(entry.missionId)
    if (entry.resolutionWorktree && mission.repoRoot)
      await removeWorktree(mission.repoRoot, entry.resolutionWorktree)
    mergeQueue.updateMergeEntry(entry.id, { resolutionWorktree: null })
  }

  private async finalize(entry: MergeQueueEntry, run: PlaybookRun): Promise<void> {
    const { mission, initiative } = context(entry.missionId)
    const slice = initiatives.getSlice(entry.sliceId)
    const root = mission.repoRoot
    if (
      !slice ||
      !root ||
      !mission.integrationBranch ||
      !entry.resolutionWorktree ||
      !entry.resolutionStartOid ||
      !entry.sliceHead ||
      !existsSync(entry.resolutionWorktree)
    ) {
      this.escalate(entry, "The resolution worktree is gone, so the merge can't be committed.", [
        "resolving",
      ])
      return
    }
    const lease = await repositoryDelegationLeases
      .acquire(root, `Mission Control merge queue (${mission.key})`)
      .catch(() => null)
    if (!lease) {
      // Try again shortly; the entry stays resolving with its worktree.
      setTimeout(() => this.onResolutionSettled(run.id), this.deps.leaseRetryMs ?? LEASE_RETRY_MS).unref?.()
      return
    }
    try {
      const verifier =
        run.proof?.verifiedBy.kind === "seat" ? run.proof.verifiedBy.address : null
      const outcome = await finalizeResolution({
        root,
        integrationBranch: mission.integrationBranch,
        directory: entry.resolutionWorktree,
        startOid: entry.resolutionStartOid,
        sliceHead: entry.sliceHead,
        conflictFiles: entry.conflictFiles,
        message: sliceMergeMessage({
          slice,
          proof: run.proof,
          playbookRunId: entry.playbookRunId,
          resolvedBy: [...(run.proof?.builderAddresses ?? []), verifier]
            .filter(Boolean)
            .join(", "),
        }),
      })
      switch (outcome.status) {
        case "merged":
          await this.completeMerge(entry, outcome.mergeCommit, ["resolving"])
          break
        case "moved":
          // The integration branch moved while the integrator worked: merge
          // again from the new head (it may be clean now).
          await this.dropResolutionWorktree(entry)
          mergeQueue.updateMergeEntry(
            entry.id,
            { status: "queued", note: "Integration moved during resolution; merging again." },
            ["resolving"]
          )
          void this.kick(mission.id)
          break
        case "unresolved":
          await this.dropResolutionWorktree(entry)
          this.escalate(
            entry,
            `Conflict markers remain after the integrator's run in: ${outcome.files.join(", ")}.`,
            ["resolving"]
          )
          break
        case "invalid":
          await this.dropResolutionWorktree(entry)
          this.escalate(entry, outcome.reason, ["resolving"])
          break
      }
    } catch (error) {
      await this.dropResolutionWorktree(entry)
      this.escalate(entry, `Committing the resolution failed: ${message(error)}`, ["resolving"])
    } finally {
      repositoryDelegationLeases.release(lease)
      this.changed(initiative.id)
    }
  }

  // ── user actions on the queue ─────────────────────────────────────────────

  // Try the merge again (e.g. after the user fixed the slice branch).
  retry(entryId: string): Promise<void> {
    const entry = mergeQueue.getMergeEntry(entryId)
    if (!entry) throw new Error("That merge is no longer queued.")
    const updated = mergeQueue.updateMergeEntry(
      entryId,
      { status: "queued", escalated: false, note: "Retry requested by the user" },
      ["conflict"]
    )
    if (!updated) throw new Error("Only a conflicted merge can be retried.")
    this.changed(context(entry.missionId).initiative.id)
    return this.kick(entry.missionId)
  }

  // Run the integrator again on a conflicted merge.
  resolve(entryId: string): Promise<void> {
    const entry = mergeQueue.getMergeEntry(entryId)
    if (!entry || entry.status !== "conflict")
      throw new Error("Only a conflicted merge can be resolved.")
    return this.enqueueWork(entry.missionId, () => this.startResolution(entryId, true))
  }

  // Give up on merging this slice attempt: the slice fails (and can be
  // retried from the current integration head); its branch is kept.
  async abandon(entryId: string): Promise<void> {
    const entry = mergeQueue.getMergeEntry(entryId)
    if (!entry) throw new Error("That merge is no longer queued.")
    await this.enqueueWork(entry.missionId, async () => {
      const cancelled = getDb().transaction(() => {
        const updated = mergeQueue.updateMergeEntry(
          entryId,
          { status: "cancelled", finishedAt: Date.now(), note: "Abandoned by the user" },
          ["conflict", "queued"]
        )
        if (!updated) return null
        const slice = initiatives.getSlice(entry.sliceId)
        if (slice?.status === "integrating")
          initiatives.setSliceExecution(
            slice.id,
            { status: "failed", finishedAt: Date.now() },
            "Merge abandoned by the user; the branch is kept for inspection",
            "user"
          )
        return updated
      })()
      if (!cancelled) throw new Error("Only a queued or conflicted merge can be abandoned.")
      await this.dropResolutionWorktree(cancelled)
      await this.releaseSliceWorktree(entry.sliceId)
      this.advanceMission(entry.missionId)
      this.changed(context(entry.missionId).initiative.id)
    })
  }

  // ── mission progress and landing ──────────────────────────────────────────

  // active → integrating while finished slices wait to merge; → review once
  // every slice that wasn't cancelled is done; back to active when one leaves
  // the queue unmerged. Idempotent and quiet when nothing changes, so it is
  // safe to call on every read (status) and after plan edits (slice delete).
  advanceMission(missionId: string): void {
    const mission = initiatives.getMission(missionId)
    if (!mission || !["active", "integrating"].includes(mission.status)) return
    const slices = initiatives.listSlices(missionId).filter((s) => s.status !== "cancelled")
    if (!slices.length) return
    const allDone = slices.every((s) => s.status === "done")
    const settled = slices.every((s) => s.status === "done" || s.status === "integrating")
    const target = allDone
      ? "review"
      : settled && mission.status === "active"
        ? "integrating"
        : !settled && mission.status === "integrating"
          ? "active"
          : null
    if (!target) return
    try {
      if (allDone)
        initiatives.advanceMissionStatus(
          missionId,
          "review",
          mission.integrationBranch
            ? "Every slice merged into the integration branch"
            : "Every slice is done"
        )
      else if (settled && mission.status === "active")
        initiatives.advanceMissionStatus(missionId, "integrating", "Every slice is merging")
      else if (!settled && mission.status === "integrating")
        initiatives.advanceMissionStatus(missionId, "active", "A slice left the merge queue")
    } catch (error) {
      console.warn("[integration] mission status:", error)
      return
    }
    this.changed(mission.initiativeId)
  }

  async status(missionId: string): Promise<MissionIntegrationStatus> {
    // Catch up on anything that changed the slice set outside a merge (a
    // deleted slice, or state written before this check existed).
    this.advanceMission(missionId)
    let { mission } = context(missionId)
    const { initiative } = context(missionId)
    const workspace: MissionIntegrationStatus["workspace"] = initiative.workspaceId
      ? await this.workspaceMode(initiative)
      : { mode: "none", reason: "The initiative has no workspace yet." }
    const root = mission.repoRoot ?? (workspace.mode === "git" ? workspace.root : null)
    let summary: LandingSummary | null = null
    if (mission.repoRoot && mission.integrationBranch && mission.baseRef) {
      summary = await landingSummary(
        mission.repoRoot,
        mission.baseRef,
        mission.integrationBranch
      ).catch(() => null)
      // Manual policy: the user merged it their own way.
      if (summary?.merged && mission.status === "review" && summary.headOid) {
        await this.completeMission(missionId, {
          mode: mission.mergePolicy.mode,
          completedBy: "detected",
          at: Date.now(),
          base: mission.baseRef,
          baseOid: summary.baseOid,
          head: summary.headOid,
        })
        mission = initiatives.getMission(missionId)!
      }
    }
    const remote = root ? await pushRemote(root, mission.baseRef ?? "HEAD") : null
    const gh = remote ? await ghAvailable() : false
    const gitReason =
      workspace.mode === "git" ? undefined : "Needs a git workspace."
    return {
      missionId,
      workspace,
      integrationBranch: mission.integrationBranch,
      baseRef: mission.baseRef,
      baseOid: mission.baseOid,
      policy: mission.mergePolicy.mode,
      policyLocked: !!mission.integrationBranch || mission.status !== "planned",
      policies: {
        manual: { available: true, visible: true },
        local_merge: {
          available: workspace.mode === "git",
          visible: true,
          reason: gitReason,
        },
        open_pr: {
          available: workspace.mode === "git" && !!remote && gh,
          visible: !!remote,
          reason: gitReason ?? (gh ? undefined : "Install and sign in to the GitHub CLI (gh)."),
        },
      },
      queue: mergeQueue.listMergeEntries({ missionId }),
      summary,
      landing: mission.landing,
    }
  }

  // The policy's terminal step, after the user's explicit approval. The
  // approval is bound to the base and head the user reviewed: if either moved,
  // nothing happens and the user reviews again.
  async land(
    missionId: string,
    approval: { baseOid: string; headOid: string }
  ): Promise<MissionLanding> {
    const { mission, initiative } = context(missionId)
    if (mission.status !== "review")
      throw new Error("The mission can land once every slice has merged.")
    const root = mission.repoRoot
    if (!root || !mission.integrationBranch || !mission.baseRef)
      throw new Error("This mission has no integration branch to land.")
    const mode = mission.mergePolicy.mode
    if (mode === "manual")
      throw new Error("A manual mission is merged by you; mark it merged when you're done.")
    if (mode === "local_merge") {
      const lease = await repositoryDelegationLeases.acquire(
        root,
        `Mission Control landing (${mission.key})`
      )
      try {
        const landed = await landLocally({
          root,
          base: mission.baseRef,
          expectedBaseOid: approval.baseOid,
          head: mission.integrationBranch,
          expectedHeadOid: approval.headOid,
          message: `Merge mission ${mission.key}: ${mission.name}\n\n${mission.outcome.trim()}\n\nMission-Control-Mission: ${mission.id}`.trim(),
          scratchDirectory: this.scratchDirectory(initiative.id, "land"),
        })
        return await this.completeMission(missionId, {
          mode,
          completedBy: "user",
          at: Date.now(),
          base: mission.baseRef,
          baseOid: approval.baseOid,
          head: approval.headOid,
          mergeCommit: landed.mergeCommit,
          fastForward: landed.fastForward,
        })
      } finally {
        repositoryDelegationLeases.release(lease)
      }
    }
    const headOid = await revParse(root, `refs/heads/${mission.integrationBranch}`)
    if (headOid !== approval.headOid)
      throw new Error(
        `${mission.integrationBranch} moved since you reviewed it. Review it again before approving.`
      )
    const pr = await openPullRequest({
      root,
      branch: mission.integrationBranch,
      base: mission.baseRef,
      title: `Mission ${mission.key}: ${mission.name}`,
      body: this.pullRequestBody(mission),
    })
    return this.completeMission(missionId, {
      mode,
      completedBy: "user",
      at: Date.now(),
      base: mission.baseRef,
      baseOid: approval.baseOid,
      head: approval.headOid,
      prUrl: pr.url,
    })
  }

  private pullRequestBody(mission: Mission): string {
    const slices = initiatives.listSlices(mission.id).filter((s) => s.status === "done")
    return [
      "## Outcome",
      mission.outcome.trim() || mission.name,
      ...(mission.definitionOfDone.trim()
        ? ["", "## Definition of done", mission.definitionOfDone.trim()]
        : []),
      "",
      "## Slices",
      ...slices.flatMap((slice) => [
        "",
        `### ${slice.key}: ${slice.title}`,
        proofSummary(slice.proof as SliceProof | null),
      ]),
      "",
      "Opened by Mission Control after the user approved landing this mission.",
    ].join("\n")
  }

  // Manual policy (or a mission without an integration branch): the user
  // says it's merged.
  async markMerged(missionId: string): Promise<MissionLanding> {
    const { mission } = context(missionId)
    if (mission.status !== "review")
      throw new Error("The mission can be marked merged once every slice is done.")
    if (mission.integrationBranch && mission.mergePolicy.mode !== "manual")
      throw new Error("Use the merge policy's action, or switch the policy to manual first.")
    const head =
      mission.repoRoot && mission.integrationBranch
        ? await revParse(mission.repoRoot, `refs/heads/${mission.integrationBranch}`)
        : null
    return this.completeMission(missionId, {
      mode: mission.mergePolicy.mode,
      completedBy: "user",
      at: Date.now(),
      base: mission.baseRef ?? "",
      baseOid: mission.baseRef && mission.repoRoot
        ? await revParse(mission.repoRoot, `refs/heads/${mission.baseRef}`)
        : null,
      head: head ?? "",
    })
  }

  private async completeMission(
    missionId: string,
    landing: MissionLanding
  ): Promise<MissionLanding> {
    const { mission, initiative } = context(missionId)
    getDb().transaction(() => {
      initiatives.setMissionLanding(missionId, landing)
      initiatives.advanceMissionStatus(
        missionId,
        "completed",
        landing.prUrl
          ? `Pull request opened: ${landing.prUrl}`
          : landing.completedBy === "detected"
            ? `Detected the integration branch in ${landing.base}`
            : landing.mergeCommit
              ? `Merged into ${landing.base} (${landing.mergeCommit.slice(0, 10)})`
              : "Marked merged by the user",
        landing.completedBy === "user" ? "user" : "mission-control"
      )
    })()
    await this.cleanupMission(mission).catch((error) =>
      console.warn("[integration] mission cleanup:", error)
    )
    this.changed(initiative.id)
    return landing
  }

  // After completion: every worktree goes; slice branches whose work is in
  // the integration branch are deleted; the integration branch itself is
  // deleted only once it is contained in the base branch (a PR's branch stays).
  private async cleanupMission(mission: Mission): Promise<void> {
    const root = mission.repoRoot
    if (!root || !mission.integrationBranch) return
    for (const slice of initiatives.listSlices(mission.id)) {
      if (slice.worktreePath) {
        await removeWorktree(root, slice.worktreePath)
        initiatives.setSliceExecution(slice.id, { worktreePath: null }, "Mission completed; worktree removed")
      }
    }
    for (const entry of mergeQueue.listMergeEntries({ missionId: mission.id }))
      if (entry.resolutionWorktree) await removeWorktree(root, entry.resolutionWorktree)
    const mergedSlices = new Set(
      initiatives
        .listSlices(mission.id)
        .filter((s) => s.status === "done")
        .map((s) => s.branch)
        .filter((b): b is string => !!b)
    )
    await deleteMergedBranches(root, [...mergedSlices], `refs/heads/${mission.integrationBranch}`)
    if (mission.baseRef)
      await deleteMergedBranches(root, [mission.integrationBranch], `refs/heads/${mission.baseRef}`)
  }

  // ── cleanup and recovery ──────────────────────────────────────────────────

  // Before an initiative is deleted: remove its worktrees and its `mc/…`
  // branches, except integration branches whose work never reached the base
  // (those are reported so nothing unmerged disappears silently).
  async cleanupInitiative(initiativeId: string): Promise<{ keptBranches: string[] }> {
    const kept: string[] = []
    const missions = initiatives.listMissions(initiativeId)
    for (const mission of missions) {
      const root = mission.repoRoot
      if (!root || !mission.integrationBranch || !existsSync(root)) continue
      for (const slice of initiatives.listSlices(mission.id))
        if (slice.worktreePath) await removeWorktree(root, slice.worktreePath)
      for (const entry of mergeQueue.listMergeEntries({ missionId: mission.id }))
        if (entry.resolutionWorktree) await removeWorktree(root, entry.resolutionWorktree)
      for (const branch of await listBranches(root, sliceBranchPrefix(mission.integrationBranch)))
        await deleteMissionControlBranch(root, branch)
      const landed = mission.baseRef
        ? (await deleteMergedBranches(root, [mission.integrationBranch], `refs/heads/${mission.baseRef}`)).length > 0
        : false
      const exists = await revParse(root, `refs/heads/${mission.integrationBranch}`)
      if (!landed && exists) {
        const baseOid = mission.baseOid
        // Nothing was ever merged into it: safe to delete.
        if (baseOid && exists === baseOid) await deleteMissionControlBranch(root, mission.integrationBranch)
        else kept.push(mission.integrationBranch)
      }
    }
    await rm(path.join(this.deps.worktreeRoot(), initiativeId), { recursive: true, force: true }).catch(
      () => {}
    )
    return { keptBranches: kept }
  }

  // Boot: remove Mission Control worktree folders nothing references (crash
  // leftovers, scratch merges, deleted initiatives), then resume every queue.
  async reconcile(): Promise<void> {
    this.ready = this.sweep().catch((error) =>
      console.warn("[integration] worktree sweep:", error)
    )
    await this.ready
    for (const initiative of initiatives.listInitiatives())
      for (const mission of initiatives.listMissions(initiative.id)) {
        const open = mergeQueue.listMergeEntries({
          missionId: mission.id,
          statuses: ["queued", "merging", "resolving"],
        })
        for (const entry of open.filter((e) => e.status === "resolving" && e.resolutionRunId))
          this.onResolutionSettled(entry.resolutionRunId!)
        if (open.some((e) => e.status !== "resolving")) void this.kick(mission.id)
      }
  }

  private async sweep(): Promise<void> {
    const root = this.deps.worktreeRoot()
    // List folders before reading references: a worktree created after the
    // listing is never a candidate.
    const initiativeDirs = await readdir(root).catch(() => [] as string[])
    const listed = new Map<string, string[]>()
    for (const initiativeDir of initiativeDirs)
      listed.set(
        initiativeDir,
        await readdir(path.join(root, initiativeDir)).catch(() => [] as string[])
      )
    const referenced = new Set<string>()
    const repoRoots = new Set<string>()
    for (const initiative of initiatives.listInitiatives())
      for (const mission of initiatives.listMissions(initiative.id)) {
        if (mission.repoRoot) repoRoots.add(mission.repoRoot)
        for (const slice of initiatives.listSlices(mission.id))
          if (slice.worktreePath) referenced.add(path.resolve(slice.worktreePath))
        for (const entry of mergeQueue.listMergeEntries({
          missionId: mission.id,
          statuses: ["resolving"],
        }))
          if (entry.resolutionWorktree) referenced.add(path.resolve(entry.resolutionWorktree))
      }
    for (const [initiativeDir, names] of listed) {
      const dir = path.join(root, initiativeDir)
      const initiative = initiatives.getInitiative(initiativeDir)
      const missionRoots = initiative
        ? initiatives.listMissions(initiative.id).map((m) => m.repoRoot).filter((r): r is string => !!r)
        : []
      for (const name of names) {
        const worktree = path.resolve(dir, name)
        if (referenced.has(worktree)) continue
        const repo = missionRoots.find((r) => existsSync(r))
        if (repo) await removeWorktree(repo, worktree)
        else await rm(worktree, { recursive: true, force: true }).catch(() => {})
      }
      if (!initiative) await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
    for (const repo of repoRoots)
      if (existsSync(repo)) await runGit(repo, ["worktree", "prune"]).catch(() => {})
  }
}

function processWorkspace(processRunId: string): string | null {
  const row = getDb()
    .prepare(
      "SELECT w.path AS path FROM process_runs r JOIN workspaces w ON w.id = r.workspace_id WHERE r.id = ?"
    )
    .get(processRunId) as { path: string } | undefined
  return row?.path ?? null
}
