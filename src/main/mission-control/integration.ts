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
import * as features from "../db/repositories/features"
import * as mergeQueue from "../db/repositories/merge-queue"
import * as playbooks from "../db/repositories/playbooks"
import { getWorkspace, upsertHiddenWorkspace } from "../db/repositories/workspaces"
import type {
  Feature,
  MergePolicyMode,
  MergeQueueEntry,
  Milestone,
  MilestoneLanding,
  PlaybookRun,
  UserStoryProof,
  WorkUserStory,
} from "../db/types"
import { deriveWaves } from "../../shared/mission-control/waves"
import {
  changedFiles,
  commitWorktreeChanges,
  createUserStoryWorktree,
  deleteMergedBranches,
  findUserStoryMerge,
  finalizeResolution,
  ghAvailable,
  integrationBranchName,
  isAncestor,
  landingSummary,
  landLocally,
  listBranches,
  mergeUserStory,
  openPullRequest,
  prepareResolution,
  pushRemote,
  repositoryRoot,
  revParse,
  userStoryBranchPrefix,
  startIntegrationBranch,
  workspaceSubpath,
  worktreeDiff,
  type LandingSummary,
} from "./milestone-git"

// Milestone integration (plan 106.5). Deterministic, restart-safe service that:
//
// - starts a milestone's integration branch (clean preflight, recorded base),
// - gives each user story attempt its own branch + worktree off the integration head,
// - merges finished user stories through a serialized, dependency-ordered queue,
// - hands conflicts to the milestone's after_each_user_story hook (integrator seat),
//   which must re-verify the user story before the merge commits, or escalates,
// - lands the milestone per its merge policy, and
// - cleans up its own worktrees and `mc/…` branches.
//
// Only conflict resolution involves an agent. Everything here is git and
// SQLite; the queue rows are the durable state, so a restart resumes where the
// last completed step left off.

export const DEFAULT_MAX_CONCURRENT_USER_STORIES = 3
// Automatic integrator attempts per queue entry before the user is asked.
const MAX_AUTO_RESOLUTIONS = 2
const LEASE_RETRY_MS = 30_000

export type WorkspaceMode =
  | { mode: "git"; root: string }
  | { mode: "single_flight"; reason: string }

export interface IsolatedUserStoryWorkspace {
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
  feature: Feature
  milestone: Milestone
  userStory: WorkUserStory
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
  onChanged?(featureId: string): void
  // Tests shorten the retry when the repository is busy.
  leaseRetryMs?: number
}

export interface PolicyOption {
  available: boolean
  // open_pr is hidden entirely when the repository has no remote.
  visible: boolean
  reason?: string
}

export interface MilestoneIntegrationStatus {
  milestoneId: string
  workspace: WorkspaceMode | { mode: "none"; reason: string }
  integrationBranch: string | null
  baseRef: string | null
  baseOid: string | null
  policy: MergePolicyMode
  policyLocked: boolean
  policies: Record<MergePolicyMode, PolicyOption>
  queue: MergeQueueEntry[]
  summary: LandingSummary | null
  landing: MilestoneLanding | null
}

export interface UserStoryWorkspaceInfo {
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

// Touched files that none of the user story's touch hints cover: the drift signal
// 106.8 consumes. A user story without hints declared nothing, so nothing drifts.
export function filesOutsideHints(files: string[], hints: string[]): string[] {
  const patterns = hints.map((h) => h.trim().replace(/^\.?\/+/, "")).filter(Boolean)
  if (!patterns.length) return []
  const matcher = ignore().add(patterns)
  return files.filter((file) => !matcher.ignores(file))
}

function proofSummary(proof: UserStoryProof | null): string {
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

export function userStoryMergeMessage(input: {
  userStory: WorkUserStory
  proof: UserStoryProof | null
  playbookRunId: string | null
  resolvedBy?: string | null
}): string {
  return [
    `user story ${input.userStory.key}: ${input.userStory.title}`,
    "",
    proofSummary(input.proof),
    "",
    `Mission-Control-User-Story: ${input.userStory.id}`,
    `Mission-Control-Proof: ${input.playbookRunId ?? "none"}`,
    ...(input.resolvedBy ? [`Mission-Control-Resolved-By: ${input.resolvedBy}`] : []),
  ].join("\n")
}

function workspacePathOf(feature: Feature): string | null {
  return feature.workspaceId
    ? (getWorkspace(feature.workspaceId)?.path ?? null)
    : null
}

function context(milestoneId: string) {
  const milestone = features.getMilestone(milestoneId)
  if (!milestone) throw new Error(`Milestone not found: ${milestoneId}`)
  const feature = features.getFeature(milestone.featureId)
  if (!feature) throw new Error(`Feature not found: ${milestone.featureId}`)
  return { milestone, feature }
}

export class MilestoneIntegration {
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

  private changed(featureId: string): void {
    this.deps.onChanged?.(featureId)
  }

  // ── mode ──────────────────────────────────────────────────────────────────

  async workspaceMode(feature: Feature): Promise<WorkspaceMode> {
    const workspace = workspacePathOf(feature)
    if (!workspace)
      return { mode: "single_flight", reason: "The feature has no workspace yet." }
    const root = await repositoryRoot(workspace)
    return root
      ? { mode: "git", root }
      : {
          mode: "single_flight",
          reason:
            "The workspace isn't a git repository, so user stories can't get their own worktrees. They run one at a time in the workspace.",
        }
  }

  // ── user story worktrees ───────────────────────────────────────────────────────

  // Start the milestone's integration branch if needed, then create this user story
  // attempt's branch + worktree from the integration head. Null means the
  // workspace isn't a git repository: the user story runs single-flight in place.
  async prepareUserStoryRun(input: {
    feature: Feature
    milestone: Milestone
    userStory: WorkUserStory
    attempt: number
  }): Promise<IsolatedUserStoryWorkspace | null> {
    const workspace = workspacePathOf(input.feature)
    if (!workspace) return null
    const mode = await this.workspaceMode(input.feature)
    if (mode.mode !== "git") return null
    await this.ready
    const milestone = await this.ensureMilestoneStarted(input.milestone.id, workspace)
    const root = milestone.repoRoot!
    const directory = path.join(
      this.deps.worktreeRoot(),
      input.feature.id,
      `${input.userStory.key}-${input.attempt}-${suffix()}`
    )
    const created = await createUserStoryWorktree({
      root,
      integrationBranch: milestone.integrationBranch!,
      userStoryKey: input.userStory.key,
      attempt: input.attempt,
      directory,
    })
    const workspacePath = path.join(directory, await workspaceSubpath(root, workspace))
    upsertHiddenWorkspace(workspacePath, `${input.userStory.key} (user story worktree)`)
    return {
      workspacePath,
      worktreePath: directory,
      branch: created.branch,
      baseOid: created.baseOid,
      integrationBranch: milestone.integrationBranch!,
      discard: async () => {
        await removeWorktree(root, directory)
        await deleteMissionControlBranch(root, created.branch)
      },
    }
  }

  // Idempotent and serialized per milestone: concurrent first user stories both see
  // one integration branch.
  private async ensureMilestoneStarted(milestoneId: string, workspace: string): Promise<Milestone> {
    const previous = this.prepares.get(milestoneId) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(async () => {
        const { milestone, feature } = context(milestoneId)
        if (milestone.integrationBranch && milestone.repoRoot) return milestone
        const branch = integrationBranchName(feature.key, milestone.key)
        const started = await startIntegrationBranch({ workspace, branch })
        return features.setMilestoneIntegration(milestoneId, {
          integrationBranch: branch,
          baseRef: started.baseRef,
          baseOid: started.baseOid,
          repoRoot: started.root,
        })
      })
    this.prepares.set(milestoneId, next)
    try {
      return await next
    } finally {
      if (this.prepares.get(milestoneId) === next) this.prepares.delete(milestoneId)
    }
  }

  // A user story attempt that ended without an accepted proof gives its worktree
  // back. Its branch stays for inspection until feature cleanup.
  async releaseUserStoryWorktree(userStoryId: string): Promise<void> {
    const userStory = features.getUserStory(userStoryId)
    if (!userStory?.worktreePath) return
    const { milestone } = context(userStory.milestoneId)
    if (["running", "proving", "integrating"].includes(userStory.status)) return
    if (milestone.repoRoot) await removeWorktree(milestone.repoRoot, userStory.worktreePath)
    features.setUserStoryExecution(
      userStory.id,
      { worktreePath: null },
      "Removed the attempt's worktree (branch kept)"
    )
  }

  info(userStoryId: string): UserStoryWorkspaceInfo {
    const userStory = features.getUserStory(userStoryId)
    if (!userStory) throw new Error(`User story not found: ${userStoryId}`)
    const { milestone } = context(userStory.milestoneId)
    const run = playbooks
      .listPlaybookRuns({ userStoryId })
      .find((r) => r.hook === "run" && r.worktreePath === userStory.worktreePath)
    const workspacePath =
      userStory.worktreePath && run?.processRunId
        ? (processWorkspace(run.processRunId) ?? userStory.worktreePath)
        : userStory.worktreePath
    return {
      branch: userStory.branch,
      worktreePath: userStory.worktreePath,
      workspacePath,
      baseOid: userStory.baseOid,
      exists: !!userStory.worktreePath && existsSync(userStory.worktreePath),
      integrationBranch: milestone.integrationBranch,
    }
  }

  // The user story's changes against the integration commit it started from,
  // including uncommitted edits while its worktree exists.
  async userStoryDiff(userStoryId: string): Promise<{ diff: string; truncated: boolean }> {
    const userStory = features.getUserStory(userStoryId)
    if (!userStory?.baseOid || !userStory.branch) return { diff: "", truncated: false }
    const { milestone } = context(userStory.milestoneId)
    const root = milestone.repoRoot
    if (!root) return { diff: "", truncated: false }
    const limit = 512 * 1024
    if (userStory.worktreePath && existsSync(userStory.worktreePath))
      return worktreeDiff(userStory.worktreePath, userStory.baseOid, limit)
    const diff = await runGit(root, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      `${userStory.baseOid}..refs/heads/${userStory.branch}`,
    ]).catch(() => "")
    return diff.length > limit
      ? { diff: diff.slice(0, limit), truncated: true }
      : { diff, truncated: false }
  }

  // ── the queue ─────────────────────────────────────────────────────────────

  // Inside the user story runner's settle transaction: an accepted user story in its
  // own worktree waits in the merge queue instead of being done.
  enqueueAcceptedUserStory(userStory: WorkUserStory, playbookRun: PlaybookRun): MergeQueueEntry {
    features.setUserStoryExecution(
      userStory.id,
      { status: "integrating", proof: playbookRun.proof ?? userStory.proof },
      "Proof accepted; queued to merge into the integration branch"
    )
    return mergeQueue.enqueueMerge({
      milestoneId: userStory.milestoneId,
      userStoryId: userStory.id,
      playbookRunId: playbookRun.id,
      proofAcceptedAt: playbookRun.proof?.acceptedAt ?? Date.now(),
    })
  }

  // Serialize work on one milestone's queue. Returns the chain's promise.
  kick(milestoneId: string): Promise<void> {
    const timer = this.retryTimers.get(milestoneId)
    if (timer) {
      clearTimeout(timer)
      this.retryTimers.delete(milestoneId)
    }
    return this.enqueueWork(milestoneId, () => this.drain(milestoneId))
  }

  private enqueueWork(milestoneId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.chains.get(milestoneId) ?? this.ready
    const next = previous
      .then(() => (this.stopped ? undefined : work()))
      .catch((error) => console.error(`[integration] milestone ${milestoneId}:`, error))
    this.chains.set(milestoneId, next)
    void next.finally(() => {
      if (this.chains.get(milestoneId) === next) this.chains.delete(milestoneId)
    })
    return next
  }

  private scheduleRetry(milestoneId: string): void {
    if (this.stopped || this.retryTimers.has(milestoneId)) return
    const timer = setTimeout(() => {
      this.retryTimers.delete(milestoneId)
      void this.kick(milestoneId)
    }, this.deps.leaseRetryMs ?? LEASE_RETRY_MS)
    timer.unref?.()
    this.retryTimers.set(milestoneId, timer)
  }

  // Merge queued entries one at a time until none is ready.
  private async drain(milestoneId: string): Promise<void> {
    await this.recoverInterrupted(milestoneId)
    for (let guard = 0; guard < 1000; guard++) {
      const entry = this.nextQueued(milestoneId)
      if (!entry) break
      const result = await this.mergeEntry(entry)
      if (result === "stop") break
    }
    this.advanceMilestone(milestoneId)
  }

  // Dependency order first (wave level), then proof-accepted time.
  private nextQueued(milestoneId: string): MergeQueueEntry | null {
    const queued = mergeQueue.listMergeEntries({ milestoneId, statuses: ["queued"] })
    if (!queued.length) return null
    const userStories = features.listUserStories(milestoneId)
    const levels = deriveWaves(userStories, features.listEdges(milestoneId)).levels
    const position = new Map(userStories.map((s) => [s.id, s.position]))
    return [...queued].sort(
      (a, b) =>
        (levels.get(a.userStoryId) ?? 0) - (levels.get(b.userStoryId) ?? 0) ||
        a.proofAcceptedAt - b.proofAcceptedAt ||
        (position.get(a.userStoryId) ?? 0) - (position.get(b.userStoryId) ?? 0)
    )[0]
  }

  // Any `merging` row at the start of a drain is stale: merges only happen
  // inside this chain. The integration branch moved with a compare-and-swap,
  // so the user story either is in it (finish the bookkeeping) or isn't (requeue).
  private async recoverInterrupted(milestoneId: string): Promise<void> {
    const stale = mergeQueue.listMergeEntries({ milestoneId, statuses: ["merging"] })
    if (!stale.length) return
    const { milestone } = context(milestoneId)
    for (const entry of stale) {
      const root = milestone.repoRoot
      const head = root ? await revParse(root, `refs/heads/${milestone.integrationBranch}`) : null
      if (root && head && entry.userStoryHead && (await isAncestor(root, entry.userStoryHead, head))) {
        const commit = await findUserStoryMerge(root, milestone.integrationBranch!, entry.userStoryId)
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
    const { milestone, feature } = context(entry.milestoneId)
    const userStory = features.getUserStory(entry.userStoryId)
    const root = milestone.repoRoot
    if (!userStory || !root || !milestone.integrationBranch || !userStory.branch) {
      this.escalate(entry, "The user story or its integration branch is no longer available.", [
        "queued",
      ])
      return "continue"
    }
    const lease = await repositoryDelegationLeases
      .acquire(root, `Mission Control merge queue (${milestone.key})`)
      .catch((error) => {
        mergeQueue.updateMergeEntry(
          entry.id,
          { note: `Waiting for the repository: ${message(error).replace(/^repository_busy:/, "")}` },
          ["queued"]
        )
        this.changed(feature.id)
        return null
      })
    if (!lease) {
      this.scheduleRetry(milestone.id)
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
      this.changed(feature.id)

      if (userStory.worktreePath && existsSync(userStory.worktreePath))
        await commitWorktreeChanges(
          userStory.worktreePath,
          `user story ${userStory.key}: ${userStory.title}\n\nWork left uncommitted at proof acceptance, recorded by Mission Control.\n\nMission-Control-User-Story: ${userStory.id}`
        )
      const userStoryHead = await revParse(root, `refs/heads/${userStory.branch}`)
      if (!userStoryHead) {
        this.escalate(started, `The user story branch ${userStory.branch} is missing.`, ["merging"])
        return "continue"
      }
      const touched = userStory.baseOid
        ? await changedFiles(root, userStory.baseOid, userStoryHead).catch(() => [])
        : []
      mergeQueue.updateMergeEntry(entry.id, {
        userStoryHead,
        touchedFiles: touched,
        outsideHints: filesOutsideHints(touched, userStory.spec.touchHints),
      })

      const playbookRun = entry.playbookRunId
        ? playbooks.getPlaybookRun(entry.playbookRunId)
        : null
      const outcome = await mergeUserStory({
        root,
        integrationBranch: milestone.integrationBranch,
        userStoryHead,
        message: userStoryMergeMessage({
          userStory,
          proof: playbookRun?.proof ?? (userStory.proof as UserStoryProof | null),
          playbookRunId: entry.playbookRunId,
        }),
        scratchDirectory: this.scratchDirectory(feature.id, "merge"),
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
      this.changed(feature.id)
      // Hand the conflict to the integrator after the lease is released: the
      // resolution worktree doesn't need it, and the queue keeps moving.
      if (conflict) await this.startResolution(entry.id, false)
    }
  }

  private scratchDirectory(featureId: string, kind: "merge" | "land"): string {
    return path.join(this.deps.worktreeRoot(), featureId, `${kind}-${suffix()}`)
  }

  // A merge landed: the entry is merged, the user story done, its worktree gone.
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
          note: mergeCommit ? null : "Nothing to merge: the user story made no changes.",
          escalated: false,
        },
        from
      )
      if (!updated) return null
      const userStory = features.getUserStory(entry.userStoryId)
      if (userStory?.status === "integrating")
        features.setUserStoryExecution(
          userStory.id,
          { status: "done", finishedAt: Date.now() },
          mergeCommit
            ? `Merged into the integration branch (${mergeCommit.slice(0, 10)})`
            : "Merged into the integration branch (no changes)"
        )
      return updated
    })()
    if (!merged) return
    const { milestone, feature } = context(entry.milestoneId)
    const userStory = features.getUserStory(entry.userStoryId)
    if (milestone.repoRoot) {
      if (userStory?.worktreePath) await removeWorktree(milestone.repoRoot, userStory.worktreePath)
      if (merged.resolutionWorktree)
        await removeWorktree(milestone.repoRoot, merged.resolutionWorktree)
    }
    if (userStory?.worktreePath)
      features.setUserStoryExecution(
        userStory.id,
        { worktreePath: null },
        "Removed the merged user story's worktree"
      )
    this.changed(feature.id)
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
    const { feature } = context(entry.milestoneId)
    const userStory = features.getUserStory(entry.userStoryId)
    this.deps.notifyUser?.(
      `Mission Control: user story ${userStory?.key ?? ""} needs you`,
      note
    )
    this.changed(feature.id)
  }

  // ── conflicts ─────────────────────────────────────────────────────────────

  // Run the milestone's after_each_user_story hook in a fresh worktree holding the
  // conflicted merge. `manual` (the user asked) skips the automatic cap.
  private async startResolution(entryId: string, manual: boolean): Promise<void> {
    const entry = mergeQueue.getMergeEntry(entryId)
    if (!entry || entry.status !== "conflict") return
    const { milestone, feature } = context(entry.milestoneId)
    const userStory = features.getUserStory(entry.userStoryId)
    if (!userStory || !milestone.repoRoot || !milestone.integrationBranch || !entry.userStoryHead) {
      this.escalate(entry, "The user story can't be merged: its branch or the integration branch is gone.", ["conflict"])
      return
    }
    if (!this.deps.startResolution) {
      this.escalate(entry, entry.note ?? "The merge conflicts.", ["conflict"])
      return
    }
    if (!manual && entry.resolutionAttempts >= MAX_AUTO_RESOLUTIONS) {
      this.escalate(
        entry,
        `The integrator didn't resolve the conflict after ${entry.resolutionAttempts} attempt(s). Resolve it on the user story branch and retry, run the integrator again, or abandon the user story.`,
        ["conflict"]
      )
      return
    }
    const workspace = workspacePathOf(feature)
    const directory = path.join(
      this.deps.worktreeRoot(),
      feature.id,
      `resolve-${userStory.key}-${suffix()}`
    )
    try {
      const prepared = await prepareResolution({
        root: milestone.repoRoot,
        integrationBranch: milestone.integrationBranch,
        userStoryHead: entry.userStoryHead,
        directory,
      })
      const files = prepared.files.length ? prepared.files : entry.conflictFiles
      const workspacePath = path.join(
        directory,
        workspace ? await workspaceSubpath(milestone.repoRoot, workspace) : ""
      )
      upsertHiddenWorkspace(workspacePath, `${userStory.key} (merge resolution)`)
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
        await removeWorktree(milestone.repoRoot, directory)
        return
      }
      this.changed(feature.id)
      await this.deps.startResolution({
        feature,
        milestone,
        userStory,
        workspacePath,
        worktreePath: directory,
        files,
        onLaunch: (run) => {
          mergeQueue.updateMergeEntry(entry.id, { resolutionRunId: run.id })
        },
      })
    } catch (error) {
      await removeWorktree(milestone.repoRoot, directory)
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
    void this.enqueueWork(entry.milestoneId, async () => {
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
      this.advanceMilestone(entry.milestoneId)
    })
  }

  private async dropResolutionWorktree(entry: MergeQueueEntry): Promise<void> {
    const { milestone } = context(entry.milestoneId)
    if (entry.resolutionWorktree && milestone.repoRoot)
      await removeWorktree(milestone.repoRoot, entry.resolutionWorktree)
    mergeQueue.updateMergeEntry(entry.id, { resolutionWorktree: null })
  }

  private async finalize(entry: MergeQueueEntry, run: PlaybookRun): Promise<void> {
    const { milestone, feature } = context(entry.milestoneId)
    const userStory = features.getUserStory(entry.userStoryId)
    const root = milestone.repoRoot
    if (
      !userStory ||
      !root ||
      !milestone.integrationBranch ||
      !entry.resolutionWorktree ||
      !entry.resolutionStartOid ||
      !entry.userStoryHead ||
      !existsSync(entry.resolutionWorktree)
    ) {
      this.escalate(entry, "The resolution worktree is gone, so the merge can't be committed.", [
        "resolving",
      ])
      return
    }
    const lease = await repositoryDelegationLeases
      .acquire(root, `Mission Control merge queue (${milestone.key})`)
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
        integrationBranch: milestone.integrationBranch,
        directory: entry.resolutionWorktree,
        startOid: entry.resolutionStartOid,
        userStoryHead: entry.userStoryHead,
        conflictFiles: entry.conflictFiles,
        message: userStoryMergeMessage({
          userStory,
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
          void this.kick(milestone.id)
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
      this.changed(feature.id)
    }
  }

  // ── user actions on the queue ─────────────────────────────────────────────

  // Try the merge again (e.g. after the user fixed the user story branch).
  retry(entryId: string): Promise<void> {
    const entry = mergeQueue.getMergeEntry(entryId)
    if (!entry) throw new Error("That merge is no longer queued.")
    const updated = mergeQueue.updateMergeEntry(
      entryId,
      { status: "queued", escalated: false, note: "Retry requested by the user" },
      ["conflict"]
    )
    if (!updated) throw new Error("Only a conflicted merge can be retried.")
    this.changed(context(entry.milestoneId).feature.id)
    return this.kick(entry.milestoneId)
  }

  // Run the integrator again on a conflicted merge.
  resolve(entryId: string): Promise<void> {
    const entry = mergeQueue.getMergeEntry(entryId)
    if (!entry || entry.status !== "conflict")
      throw new Error("Only a conflicted merge can be resolved.")
    return this.enqueueWork(entry.milestoneId, () => this.startResolution(entryId, true))
  }

  // Give up on merging this user story attempt: the user story fails (and can be
  // retried from the current integration head); its branch is kept.
  async abandon(entryId: string): Promise<void> {
    const entry = mergeQueue.getMergeEntry(entryId)
    if (!entry) throw new Error("That merge is no longer queued.")
    await this.enqueueWork(entry.milestoneId, async () => {
      const cancelled = getDb().transaction(() => {
        const updated = mergeQueue.updateMergeEntry(
          entryId,
          { status: "cancelled", finishedAt: Date.now(), note: "Abandoned by the user" },
          ["conflict", "queued"]
        )
        if (!updated) return null
        const userStory = features.getUserStory(entry.userStoryId)
        if (userStory?.status === "integrating")
          features.setUserStoryExecution(
            userStory.id,
            { status: "failed", finishedAt: Date.now() },
            "Merge abandoned by the user; the branch is kept for inspection",
            "user"
          )
        return updated
      })()
      if (!cancelled) throw new Error("Only a queued or conflicted merge can be abandoned.")
      await this.dropResolutionWorktree(cancelled)
      await this.releaseUserStoryWorktree(entry.userStoryId)
      this.advanceMilestone(entry.milestoneId)
      this.changed(context(entry.milestoneId).feature.id)
    })
  }

  // ── milestone progress and landing ──────────────────────────────────────────

  // active → integrating while finished user stories wait to merge; → review once
  // every user story that wasn't cancelled is done; back to active when one leaves
  // the queue unmerged. Idempotent and quiet when nothing changes, so it is
  // safe to call on every read (status) and after plan edits (user story delete).
  advanceMilestone(milestoneId: string): void {
    const milestone = features.getMilestone(milestoneId)
    if (!milestone || !["active", "integrating"].includes(milestone.status)) return
    const userStories = features.listUserStories(milestoneId).filter((s) => s.status !== "cancelled")
    if (!userStories.length) return
    const allDone = userStories.every((s) => s.status === "done")
    const settled = userStories.every((s) => s.status === "done" || s.status === "integrating")
    const target = allDone
      ? "review"
      : settled && milestone.status === "active"
        ? "integrating"
        : !settled && milestone.status === "integrating"
          ? "active"
          : null
    if (!target) return
    try {
      if (allDone)
        features.advanceMilestoneStatus(
          milestoneId,
          "review",
          milestone.integrationBranch
            ? "Every user story merged into the integration branch"
            : "Every user story is done"
        )
      else if (settled && milestone.status === "active")
        features.advanceMilestoneStatus(milestoneId, "integrating", "Every user story is merging")
      else if (!settled && milestone.status === "integrating")
        features.advanceMilestoneStatus(milestoneId, "active", "A user story left the merge queue")
    } catch (error) {
      console.warn("[integration] milestone status:", error)
      return
    }
    this.changed(milestone.featureId)
  }

  async status(milestoneId: string): Promise<MilestoneIntegrationStatus> {
    // Catch up on anything that changed the user story set outside a merge (a
    // deleted user story, or state written before this check existed).
    this.advanceMilestone(milestoneId)
    let { milestone } = context(milestoneId)
    const { feature } = context(milestoneId)
    const workspace: MilestoneIntegrationStatus["workspace"] = feature.workspaceId
      ? await this.workspaceMode(feature)
      : { mode: "none", reason: "The feature has no workspace yet." }
    const root = milestone.repoRoot ?? (workspace.mode === "git" ? workspace.root : null)
    let summary: LandingSummary | null = null
    if (milestone.repoRoot && milestone.integrationBranch && milestone.baseRef) {
      summary = await landingSummary(
        milestone.repoRoot,
        milestone.baseRef,
        milestone.integrationBranch
      ).catch(() => null)
      // Manual policy: the user merged it their own way.
      if (summary?.merged && milestone.status === "review" && summary.headOid) {
        await this.completeMilestone(milestoneId, {
          mode: milestone.mergePolicy.mode,
          completedBy: "detected",
          at: Date.now(),
          base: milestone.baseRef,
          baseOid: summary.baseOid,
          head: summary.headOid,
        })
        milestone = features.getMilestone(milestoneId)!
      }
    }
    const remote = root ? await pushRemote(root, milestone.baseRef ?? "HEAD") : null
    const gh = remote ? await ghAvailable() : false
    const gitReason =
      workspace.mode === "git" ? undefined : "Needs a git workspace."
    return {
      milestoneId,
      workspace,
      integrationBranch: milestone.integrationBranch,
      baseRef: milestone.baseRef,
      baseOid: milestone.baseOid,
      policy: milestone.mergePolicy.mode,
      policyLocked: !!milestone.integrationBranch || milestone.status !== "planned",
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
      queue: mergeQueue.listMergeEntries({ milestoneId }),
      summary,
      landing: milestone.landing,
    }
  }

  // The policy's terminal step, after the user's explicit approval. The
  // approval is bound to the base and head the user reviewed: if either moved,
  // nothing happens and the user reviews again.
  // A manual-policy milestone may also be merged here (`localMerge`): the user
  // still reviews and approves exactly the same base and head (106.6).
  async land(
    milestoneId: string,
    approval: { baseOid: string; headOid: string },
    options: { localMerge?: boolean } = {}
  ): Promise<MilestoneLanding> {
    const { milestone, feature } = context(milestoneId)
    if (milestone.status !== "review")
      throw new Error("The milestone can land once every user story has merged.")
    const root = milestone.repoRoot
    if (!root || !milestone.integrationBranch || !milestone.baseRef)
      throw new Error("This milestone has no integration branch to land.")
    const mode =
      options.localMerge && milestone.mergePolicy.mode === "manual"
        ? "local_merge"
        : milestone.mergePolicy.mode
    if (mode === "manual")
      throw new Error("A manual milestone is merged by you; mark it merged when you're done.")
    if (mode === "local_merge") {
      const lease = await repositoryDelegationLeases.acquire(
        root,
        `Mission Control landing (${milestone.key})`
      )
      try {
        const landed = await landLocally({
          root,
          base: milestone.baseRef,
          expectedBaseOid: approval.baseOid,
          head: milestone.integrationBranch,
          expectedHeadOid: approval.headOid,
          message: `Merge milestone ${milestone.key}: ${milestone.name}\n\n${milestone.outcome.trim()}\n\nMission-Control-Milestone: ${milestone.id}`.trim(),
          scratchDirectory: this.scratchDirectory(feature.id, "land"),
        })
        return await this.completeMilestone(milestoneId, {
          mode,
          completedBy: "user",
          at: Date.now(),
          base: milestone.baseRef,
          baseOid: approval.baseOid,
          head: approval.headOid,
          mergeCommit: landed.mergeCommit,
          fastForward: landed.fastForward,
        })
      } finally {
        repositoryDelegationLeases.release(lease)
      }
    }
    const headOid = await revParse(root, `refs/heads/${milestone.integrationBranch}`)
    if (headOid !== approval.headOid)
      throw new Error(
        `${milestone.integrationBranch} moved since you reviewed it. Review it again before approving.`
      )
    const pr = await openPullRequest({
      root,
      branch: milestone.integrationBranch,
      base: milestone.baseRef,
      title: `Milestone ${milestone.key}: ${milestone.name}`,
      body: this.pullRequestBody(milestone),
    })
    return this.completeMilestone(milestoneId, {
      mode,
      completedBy: "user",
      at: Date.now(),
      base: milestone.baseRef,
      baseOid: approval.baseOid,
      head: approval.headOid,
      prUrl: pr.url,
    })
  }

  private pullRequestBody(milestone: Milestone): string {
    const userStories = features.listUserStories(milestone.id).filter((s) => s.status === "done")
    return [
      "## Outcome",
      milestone.outcome.trim() || milestone.name,
      ...(milestone.definitionOfDone.trim()
        ? ["", "## Definition of done", milestone.definitionOfDone.trim()]
        : []),
      "",
      "## User stories",
      ...userStories.flatMap((userStory) => [
        "",
        `### ${userStory.key}: ${userStory.title}`,
        proofSummary(userStory.proof as UserStoryProof | null),
      ]),
      "",
      "Opened by Mission Control after the user approved landing this milestone.",
    ].join("\n")
  }

  // Manual policy (or a milestone without an integration branch): the user
  // says it's merged. The Navigator (plan 106.6) may complete only a milestone
  // with nothing to land — no integration branch — once the lead judged its
  // definition of done met.
  async markMerged(
    milestoneId: string,
    by: "user" | "navigator" = "user"
  ): Promise<MilestoneLanding> {
    const { milestone } = context(milestoneId)
    if (milestone.status !== "review")
      throw new Error("The milestone can be marked merged once every user story is done.")
    if (by === "navigator" && (milestone.integrationBranch || !milestone.dodReview))
      throw new Error("Only the user can land a milestone with an integration branch.")
    if (milestone.integrationBranch && milestone.mergePolicy.mode !== "manual")
      throw new Error("Use the merge policy's action, or switch the policy to manual first.")
    const head =
      milestone.repoRoot && milestone.integrationBranch
        ? await revParse(milestone.repoRoot, `refs/heads/${milestone.integrationBranch}`)
        : null
    return this.completeMilestone(milestoneId, {
      mode: milestone.mergePolicy.mode,
      completedBy: by,
      at: Date.now(),
      base: milestone.baseRef ?? "",
      baseOid: milestone.baseRef && milestone.repoRoot
        ? await revParse(milestone.repoRoot, `refs/heads/${milestone.baseRef}`)
        : null,
      head: head ?? "",
    })
  }

  private async completeMilestone(
    milestoneId: string,
    landing: MilestoneLanding
  ): Promise<MilestoneLanding> {
    const { milestone, feature } = context(milestoneId)
    getDb().transaction(() => {
      features.setMilestoneLanding(milestoneId, landing)
      features.advanceMilestoneStatus(
        milestoneId,
        "completed",
        landing.prUrl
          ? `Pull request opened: ${landing.prUrl}`
          : landing.completedBy === "detected"
            ? `Detected the integration branch in ${landing.base}`
            : landing.mergeCommit
              ? `Merged into ${landing.base} (${landing.mergeCommit.slice(0, 10)})`
              : landing.completedBy === "navigator"
                ? "Completed by the Navigator after the definition-of-done review"
                : "Marked merged by the user",
        landing.completedBy === "user"
          ? "user"
          : landing.completedBy === "navigator"
            ? "navigator@rig"
            : "mission-control"
      )
    })()
    await this.cleanupMilestone(milestone).catch((error) =>
      console.warn("[integration] milestone cleanup:", error)
    )
    this.changed(feature.id)
    return landing
  }

  // After completion: every worktree goes; user story branches whose work is in
  // the integration branch are deleted; the integration branch itself is
  // deleted only once it is contained in the base branch (a PR's branch stays).
  private async cleanupMilestone(milestone: Milestone): Promise<void> {
    const root = milestone.repoRoot
    if (!root || !milestone.integrationBranch) return
    for (const userStory of features.listUserStories(milestone.id)) {
      if (userStory.worktreePath) {
        await removeWorktree(root, userStory.worktreePath)
        features.setUserStoryExecution(userStory.id, { worktreePath: null }, "Milestone completed; worktree removed")
      }
    }
    for (const entry of mergeQueue.listMergeEntries({ milestoneId: milestone.id }))
      if (entry.resolutionWorktree) await removeWorktree(root, entry.resolutionWorktree)
    const mergedUserStories = new Set(
      features
        .listUserStories(milestone.id)
        .filter((s) => s.status === "done")
        .map((s) => s.branch)
        .filter((b): b is string => !!b)
    )
    await deleteMergedBranches(root, [...mergedUserStories], `refs/heads/${milestone.integrationBranch}`)
    if (milestone.baseRef)
      await deleteMergedBranches(root, [milestone.integrationBranch], `refs/heads/${milestone.baseRef}`)
  }

  // ── cleanup and recovery ──────────────────────────────────────────────────

  // Before a feature is deleted: remove its worktrees and its `mc/…`
  // branches, except integration branches whose work never reached the base
  // (those are reported so nothing unmerged disappears silently).
  async cleanupFeature(featureId: string): Promise<{ keptBranches: string[] }> {
    const kept: string[] = []
    const milestones = features.listMilestones(featureId)
    for (const milestone of milestones) {
      const root = milestone.repoRoot
      if (!root || !milestone.integrationBranch || !existsSync(root)) continue
      for (const userStory of features.listUserStories(milestone.id))
        if (userStory.worktreePath) await removeWorktree(root, userStory.worktreePath)
      for (const entry of mergeQueue.listMergeEntries({ milestoneId: milestone.id }))
        if (entry.resolutionWorktree) await removeWorktree(root, entry.resolutionWorktree)
      for (const branch of await listBranches(root, userStoryBranchPrefix(milestone.integrationBranch)))
        await deleteMissionControlBranch(root, branch)
      const landed = milestone.baseRef
        ? (await deleteMergedBranches(root, [milestone.integrationBranch], `refs/heads/${milestone.baseRef}`)).length > 0
        : false
      const exists = await revParse(root, `refs/heads/${milestone.integrationBranch}`)
      if (!landed && exists) {
        const baseOid = milestone.baseOid
        // Nothing was ever merged into it: safe to delete.
        if (baseOid && exists === baseOid) await deleteMissionControlBranch(root, milestone.integrationBranch)
        else kept.push(milestone.integrationBranch)
      }
    }
    await rm(path.join(this.deps.worktreeRoot(), featureId), { recursive: true, force: true }).catch(
      () => {}
    )
    return { keptBranches: kept }
  }

  // Boot: remove Mission Control worktree folders nothing references (crash
  // leftovers, scratch merges, deleted features), then resume every queue.
  async reconcile(): Promise<void> {
    this.ready = this.sweep().catch((error) =>
      console.warn("[integration] worktree sweep:", error)
    )
    await this.ready
    for (const feature of features.listFeatures())
      for (const milestone of features.listMilestones(feature.id)) {
        const open = mergeQueue.listMergeEntries({
          milestoneId: milestone.id,
          statuses: ["queued", "merging", "resolving"],
        })
        for (const entry of open.filter((e) => e.status === "resolving" && e.resolutionRunId))
          this.onResolutionSettled(entry.resolutionRunId!)
        if (open.some((e) => e.status !== "resolving")) void this.kick(milestone.id)
      }
  }

  private async sweep(): Promise<void> {
    const root = this.deps.worktreeRoot()
    // List folders before reading references: a worktree created after the
    // listing is never a candidate.
    const featureDirs = await readdir(root).catch(() => [] as string[])
    const listed = new Map<string, string[]>()
    for (const featureDir of featureDirs)
      listed.set(
        featureDir,
        await readdir(path.join(root, featureDir)).catch(() => [] as string[])
      )
    const referenced = new Set<string>()
    const repoRoots = new Set<string>()
    for (const feature of features.listFeatures())
      for (const milestone of features.listMilestones(feature.id)) {
        if (milestone.repoRoot) repoRoots.add(milestone.repoRoot)
        for (const userStory of features.listUserStories(milestone.id))
          if (userStory.worktreePath) referenced.add(path.resolve(userStory.worktreePath))
        for (const entry of mergeQueue.listMergeEntries({
          milestoneId: milestone.id,
          statuses: ["resolving"],
        }))
          if (entry.resolutionWorktree) referenced.add(path.resolve(entry.resolutionWorktree))
      }
    for (const [featureDir, names] of listed) {
      const dir = path.join(root, featureDir)
      const feature = features.getFeature(featureDir)
      const milestoneRoots = feature
        ? features.listMilestones(feature.id).map((m) => m.repoRoot).filter((r): r is string => !!r)
        : []
      for (const name of names) {
        const worktree = path.resolve(dir, name)
        if (referenced.has(worktree)) continue
        const repo = milestoneRoots.find((r) => existsSync(r))
        if (repo) await removeWorktree(repo, worktree)
        else await rm(worktree, { recursive: true, force: true }).catch(() => {})
      }
      if (!feature) await rm(dir, { recursive: true, force: true }).catch(() => {})
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
