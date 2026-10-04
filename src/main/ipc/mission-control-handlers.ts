import { readFile, writeFile } from "fs/promises"
import {
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type OpenDialogOptions,
} from "electron"
import { agentSources } from "../agent/agents/sources"
import { loadAgents } from "../agent/agents/loader"
import * as rigs from "../db/repositories/rigs"
import * as features from "../db/repositories/features"
import * as playbooks from "../db/repositories/playbooks"
import {
  buildRigExport,
  importRigExport,
  type RigExport,
} from "../mission-control/io"
import {
  createDefaultPlaybook,
  diffPlaybookWithDefault,
  resetPlaybookToDefault,
} from "../mission-control/playbook-defaults"
import {
  convertAgentsToSeatRoles,
  importProcessAsPlaybook,
  listAgentsForRoleConversion,
  listProcessRunHistory,
} from "../mission-control/playbook-import"
import type { UserStoryRunner } from "../mission-control/user-story-runner"
import type { SeatComms } from "../mission-control/comms"
import type { SeatSessionService } from "../mission-control/sessions"
import * as seatCommsRepo from "../db/repositories/seat-comms"
import * as seatSessionsRepo from "../db/repositories/seat-sessions"
import { deleteConversationsWithArtifacts } from "../conversations/lifecycle"
import { startHookRun } from "../mission-control/hook-runner"
import type { MilestoneIntegration } from "../mission-control/integration"
import type { Navigator } from "../mission-control/navigator"
import type { HealthMonitor } from "../mission-control/health/monitor"
import type { WorkspaceAnalysisService } from "../mission-control/workspace-analysis"
import {
  applyProposal,
  checkProposal,
  judgeMilestoneDone,
  rejectProposal,
} from "../mission-control/map-tools"
import * as proposalsRepo from "../db/repositories/proposals"
import { locateEvidence, readEvidence } from "../mission-control/evidence"
import {
  installTestBrowser,
  refreshTestBrowserState,
} from "../mission-control/playwright-install"
import * as seatMemoriesRepo from "../db/repositories/seat-memories"
import {
  listSeatMemoriesForSeat,
  retractSeatMemory,
  shareSeatMemory,
} from "../mission-control/seat-memory"
import {
  applyFollowup,
  defaultFollowupTarget,
} from "../mission-control/followups"
import type { FollowupTarget } from "../../shared/mission-control/plan-changes"
import * as navigatorTicks from "../db/repositories/navigator-ticks"
import { parseSeatAddress } from "../../shared/mission-control/address"
import type {
  DriveMode,
  MergePolicyMode,
  PlaybookAltitude,
  PlaybookHookName,
  PlaybookRunStatus,
} from "../db/types"

async function agents(workspace?: string) {
  return loadAgents(agentSources(workspace))
}

export function registerMissionControlHandlers(
  userStoryRunner: UserStoryRunner,
  seatComms: SeatComms,
  seatSessions: SeatSessionService,
  integration: MilestoneIntegration,
  navigator: Navigator,
  health: HealthMonitor,
  // Open a folder in the user's IDE (settings), for user story worktrees.
  openFolder: (folder: string) => Promise<string>,
  analysis: WorkspaceAnalysisService
): void {
  const graphOf = (id: string) => {
    const graph = features.getFeatureGraph(id)
    if (!graph) throw new Error(`Feature not found: ${id}`)
    return graph
  }

  // The Navigator and drive controls (plan 106.6). Budgets and the drive
  // mode are the user's alone: no tool reaches these handlers.
  // Start runs the workspace preflight first (plan 106.11): it applies what's
  // safe and stops on blockers, unless the user chose to start anyway. The
  // feature activates, and the rig is snapshotted, only after it passes.
  // `reviewed`: the user already chose what to do about the setup that
  // saves commands (Apply and start, or Start without them).
  const preflight = async (id: string, skip: boolean, reviewed: boolean) => {
    const none = [] as string[]
    if (skip)
      return { blocked: false, applied: none, blockers: none, review: none }
    const result = await analysis.preflight(id)
    return {
      blocked: !result.ok,
      applied: result.applied,
      blockers: result.blockers,
      review: result.ok && !reviewed ? result.review : none,
    }
  }
  ipcMain.handle(
    "missionControl:drive:start",
    async (
      _event,
      id: string,
      options: {
        mode: DriveMode
        autoApplyPlan?: boolean
        skipPreflight?: boolean
        reviewed?: boolean
      }
    ) => {
      const checked = await preflight(
        id,
        options?.skipPreflight === true,
        options?.reviewed === true
      )
      // Blockers stop Start; unreviewed setup pauses it for one review.
      if (checked.blocked || checked.review.length)
        return { graph: graphOf(id), planningError: null, preflight: checked }
      const started = await navigator.startDrive(id, {
        mode: options?.mode ?? "manual",
        autoApplyPlan: options?.autoApplyPlan === true,
      })
      return {
        graph: graphOf(id),
        planningError: started.planningError,
        preflight: checked,
      }
    }
  )
  ipcMain.handle(
    "missionControl:drive:pause",
    (_event, id: string, reason?: string) => {
      navigator.pause(id, reason?.trim() || "Paused by the user", "user")
      return graphOf(id)
    }
  )
  ipcMain.handle("missionControl:drive:resume", (_event, id: string) => {
    navigator.resume(id)
    return graphOf(id)
  })
  ipcMain.handle("missionControl:drive:reopen", (_event, id: string) => {
    navigator.reopen(id)
    return graphOf(id)
  })
  ipcMain.handle("missionControl:drive:cancel", (_event, id: string) => {
    navigator.cancel(id)
    return graphOf(id)
  })
  ipcMain.handle(
    "missionControl:drive:setMode",
    (_event, id: string, mode: DriveMode) => {
      navigator.setMode(id, mode)
      return graphOf(id)
    }
  )
  ipcMain.handle(
    "missionControl:drive:setOverlapPolicy",
    (_event, id: string, value: string) => {
      navigator.setOverlapPolicy(id, value === "parallel" ? "parallel" : "wait")
      return graphOf(id)
    }
  )
  ipcMain.handle(
    "missionControl:drive:setAutoApplyPlan",
    (_event, id: string, value: boolean) => {
      navigator.setAutoApplyPlan(id, value === true)
      return graphOf(id)
    }
  )
  ipcMain.handle(
    "missionControl:budgets:set",
    (_event, id: string, patch: Record<string, number | null>) => {
      features.setFeatureBudgets(id, patch ?? {}, "user")
      return graphOf(id)
    }
  )
  ipcMain.handle("missionControl:navigator:position", (_event, id: string) =>
    navigator.position(id)
  )
  ipcMain.handle(
    "missionControl:navigator:ticks",
    (_event, id: string, limit?: number) =>
      navigatorTicks.listTicks(id, limit ?? 50)
  )
  // Health (plan 106.8). Thresholds are feature budgets (budgets:set); the
  // signal lifecycle and detector mutes are the user's alone.
  ipcMain.handle("missionControl:health:report", (_event, id: string) =>
    health.report(id)
  )
  ipcMain.handle("missionControl:health:anchors", (_event, id: string) =>
    health.anchors(id)
  )
  ipcMain.handle(
    "missionControl:health:setSignalStatus",
    (
      _event,
      signalId: string,
      action: "acknowledge" | "resolve" | "mute" | "unmute"
    ) => {
      if (!["acknowledge", "resolve", "mute", "unmute"].includes(action))
        throw new Error(`Unknown signal action: ${action}`)
      return health.setSignalStatus(signalId, action)
    }
  )
  ipcMain.handle(
    "missionControl:health:muteDetector",
    (_event, id: string, detector: string, muted: boolean) => {
      health.setDetectorMuted(id, detector, muted === true)
      return health.report(id)
    }
  )
  // Rejections and partial applications go back to the seat that proposed,
  // in the user's words.
  const deliverToProposer = (
    resolved: { featureId: string; proposer: string },
    body: string,
    subject: string
  ) => {
    if (!parseSeatAddress(resolved.proposer)) return
    const result = seatComms.userNote({
      featureId: resolved.featureId,
      to: resolved.proposer,
      body,
      subject,
    })
    if (!result.ok)
      console.warn("[proposals] note not delivered:", result.message)
  }
  // Pending proposals carry which of their changes no longer apply.
  // A pending follow-up carries where it lands by default instead (106.7).
  ipcMain.handle("missionControl:proposals:list", (_event, featureId: string) =>
    proposalsRepo
      .listProposals(featureId)
      .map((proposal) =>
        proposal.status !== "pending"
          ? proposal
          : proposal.kind === "followup"
            ? { ...proposal, defaultTarget: defaultFollowupTarget(proposal) }
            : { ...proposal, problems: checkProposal(proposal) }
      )
  )
  ipcMain.handle(
    "missionControl:proposals:applyFollowup",
    (
      _event,
      id: string,
      target: FollowupTarget | null,
      options?: { allowCurrent?: boolean }
    ) => {
      const proposal = applyFollowup(id, target ?? null, {
        by: "user",
        allowCurrent: options?.allowCurrent === true,
      })
      return graphOf(proposal.featureId)
    }
  )

  // Seat memory (plan 106.7). Every write here is the user's: no tool
  // reaches these handlers.
  ipcMain.handle(
    "missionControl:seatMemory:list",
    (_event, rigId: string, seatAddress?: string) =>
      listSeatMemoriesForSeat(rigId, seatAddress || undefined)
  )
  ipcMain.handle(
    "missionControl:seatMemory:pendingCount",
    (_event, rigId: string) => seatMemoriesRepo.countPendingSeatMemories(rigId)
  )
  ipcMain.handle(
    "missionControl:seatMemory:review",
    (_event, id: string, decision: "approve" | "reject", content?: string) =>
      seatMemoriesRepo.reviewSeatMemory(
        id,
        decision === "approve" ? "approve" : "reject",
        typeof content === "string" ? content : undefined
      )
  )
  ipcMain.handle(
    "missionControl:seatMemory:share",
    (_event, id: string, targetAddress: string) =>
      shareSeatMemory(id, targetAddress)
  )
  ipcMain.handle(
    "missionControl:seatMemory:retract",
    (_event, id: string, reason: string) => retractSeatMemory(id, reason ?? "")
  )
  ipcMain.handle(
    "missionControl:proposals:apply",
    (_event, id: string, options?: { partial?: boolean }) => {
      const proposal = applyProposal(id, "user", {
        partial: options?.partial === true,
        deliver: (resolved, body) =>
          deliverToProposer(resolved, body, "Proposal partly applied"),
      })
      return graphOf(proposal.featureId)
    }
  )
  // The user's definition-of-done judgment for a milestone.
  ipcMain.handle(
    "missionControl:milestones:judgeDone",
    async (_event, milestoneId: string, summary: string) => {
      await judgeMilestoneDone(milestoneId, summary ?? "", async (id) => {
        await integration.markMerged(id)
      })
      const milestone = features.getMilestone(milestoneId)
      return graphOf(milestone!.featureId)
    }
  )
  ipcMain.handle(
    "missionControl:proposals:reject",
    (_event, id: string, note?: string) => {
      const proposal = rejectProposal(id, note ?? "", (resolved, body) =>
        deliverToProposer(resolved, body, "Proposal rejected")
      )
      return graphOf(proposal.featureId)
    }
  )
  ipcMain.handle(
    "missionControl:comms:acknowledge",
    (_event, messageId: string) => seatComms.acknowledge(messageId)
  )
  ipcMain.handle(
    "missionControl:comms:reply",
    (_event, messageId: string, body: string) => {
      const result = seatComms.userReply(messageId, body ?? "")
      if (!result.ok) throw new Error(result.message)
      return result.message
    }
  )
  // Milestone integration (plan 106.5). Landing is the one call that may change
  // the user's branch, and only with the base/head the user reviewed.
  ipcMain.handle(
    "missionControl:integration:status",
    (_event, milestoneId: string) => integration.status(milestoneId)
  )
  ipcMain.handle(
    "missionControl:integration:setPolicy",
    (_event, milestoneId: string, mode: MergePolicyMode) =>
      features.setMilestoneMergePolicy(milestoneId, mode)
  )
  ipcMain.handle(
    "missionControl:integration:land",
    (
      _event,
      milestoneId: string,
      approval: { baseOid: string; headOid: string },
      options?: { localMerge?: boolean }
    ) => {
      if (
        typeof approval?.baseOid !== "string" ||
        typeof approval?.headOid !== "string"
      )
        throw new Error("Review the merge before approving it.")
      return integration.land(milestoneId, approval, {
        localMerge: options?.localMerge === true,
      })
    }
  )
  ipcMain.handle(
    "missionControl:integration:markMerged",
    (_event, milestoneId: string) => integration.markMerged(milestoneId)
  )
  ipcMain.handle(
    "missionControl:integration:retry",
    (_event, entryId: string) => integration.retry(entryId)
  )
  ipcMain.handle(
    "missionControl:integration:resolve",
    (_event, entryId: string) => integration.resolve(entryId)
  )
  ipcMain.handle(
    "missionControl:integration:abandon",
    (_event, entryId: string) => integration.abandon(entryId)
  )
  ipcMain.handle(
    "missionControl:integration:userStoryInfo",
    (_event, userStoryId: string) => integration.info(userStoryId)
  )
  ipcMain.handle(
    "missionControl:integration:userStoryDiff",
    (_event, userStoryId: string) => integration.userStoryDiff(userStoryId)
  )
  ipcMain.handle(
    "missionControl:integration:openWorktree",
    async (_event, userStoryId: string) => {
      const info = integration.info(userStoryId)
      if (!info.exists || !info.workspacePath)
        return "This user story has no worktree right now."
      return openFolder(info.workspacePath)
    }
  )

  // Comms and seat sessions (plan 106.4). Agent threads are read-only here: the
  // user's only write is an explicit Steer, sent from user@rig.
  ipcMain.handle("missionControl:comms:list", (_event, featureId: string) => ({
    threads: seatCommsRepo.listThreads(featureId),
    messages: seatCommsRepo.listMessages({ featureId, limit: 2000 }),
  }))
  ipcMain.handle("missionControl:comms:seats", (_event, featureId: string) =>
    seatSessions.overview(featureId)
  )
  ipcMain.handle(
    "missionControl:comms:steer",
    (
      _event,
      input: { featureId: string; to: string; body: string; direct?: boolean }
    ) => {
      const result = seatComms.steer(input)
      if (!result.ok) throw new Error(result.message)
      return result.message
    }
  )
  ipcMain.handle(
    "missionControl:comms:rotate",
    (_event, sessionId: string, reason?: string) =>
      seatSessions.rotate(sessionId, reason?.trim() || "Rotated by the user")
  )

  // Playbooks and execution (plan 106.3).
  ipcMain.handle("missionControl:playbooks:list", () =>
    playbooks.listPlaybooks()
  )
  ipcMain.handle("missionControl:playbooks:processIds", () =>
    playbooks.listPlaybookProcessIds()
  )
  ipcMain.handle(
    "missionControl:playbooks:create",
    (
      _event,
      input: { name: string; altitude: PlaybookAltitude; description?: string }
    ) => playbooks.createPlaybook(input)
  )
  ipcMain.handle(
    "missionControl:playbooks:createDefault",
    (_event, altitude: PlaybookAltitude) => createDefaultPlaybook(altitude)
  )
  // Proof evidence (plan 109.05): a saved screenshot as a data URL for the
  // proof view, and opening any saved evidence file. Both refuse paths
  // outside the app-data evidence directory.
  ipcMain.handle("missionControl:evidence:read", (_event, path: string) =>
    readEvidence(String(path))
  )
  // The bundled Playwright runner's test browser (plan 109.06): its state,
  // and the user's consented one-time download. Changes are pushed as
  // "missionControl:testBrowser:changed" from main/index.ts.
  ipcMain.handle("missionControl:testBrowser:get", () =>
    refreshTestBrowserState()
  )
  ipcMain.handle("missionControl:testBrowser:install", () =>
    installTestBrowser()
  )
  ipcMain.handle(
    "missionControl:evidence:open",
    async (_event, path: string): Promise<void> => {
      const file = await locateEvidence(String(path))
      if (file) await shell.openPath(file)
    }
  )
  ipcMain.handle("missionControl:playbooks:defaultDiff", (_event, id: string) =>
    diffPlaybookWithDefault(id)
  )
  ipcMain.handle(
    "missionControl:playbooks:resetToDefault",
    (_event, id: string) => resetPlaybookToDefault(id)
  )
  ipcMain.handle(
    "missionControl:playbooks:update",
    (
      _event,
      id: string,
      patch: { name?: string; description?: string | null }
    ) => playbooks.updatePlaybook(id, patch)
  )
  ipcMain.handle("missionControl:playbooks:delete", (_event, id: string) =>
    playbooks.deletePlaybook(id)
  )
  // Processes sunset (plan 106.9): a Process as a user story playbook, the
  // optional agent → seat role conversion, and the run history.
  ipcMain.handle(
    "missionControl:playbooks:importProcess",
    (_event, processId: string) => importProcessAsPlaybook(processId)
  )
  ipcMain.handle(
    "missionControl:playbooks:roleConversion",
    async (_event, processId: string) =>
      listAgentsForRoleConversion(processId, await agents())
  )
  ipcMain.handle(
    "missionControl:playbooks:convertRoles",
    (
      _event,
      input: {
        processId: string
        mapping: Record<string, string>
        rigId?: string | null
      }
    ) => convertAgentsToSeatRoles(input)
  )
  ipcMain.handle("missionControl:playbooks:history", () =>
    listProcessRunHistory()
  )
  ipcMain.handle(
    "missionControl:playbooks:createHookProcess",
    (_event, id: string, hook: string) => playbooks.createHookProcess(id, hook)
  )
  ipcMain.handle(
    "missionControl:playbooks:removeHook",
    (_event, id: string, hook: PlaybookHookName) =>
      playbooks.removeHook(id, hook)
  )
  ipcMain.handle(
    "missionControl:playbookRuns:list",
    (
      _event,
      filter: {
        featureId?: string
        milestoneId?: string
        userStoryId?: string
        status?: PlaybookRunStatus
      }
    ) => playbooks.listPlaybookRuns(filter)
  )
  ipcMain.handle("missionControl:playbookRuns:cancel", (_event, id: string) =>
    userStoryRunner.cancelPlaybookRun(id)
  )
  ipcMain.handle(
    "missionControl:userStories:run",
    (_event, userStoryId: string, options?: { allowTouchOverlap?: boolean }) =>
      userStoryRunner.startUserStory(userStoryId, {
        allowTouchOverlap: options?.allowTouchOverlap === true,
        actor: "user",
      })
  )
  ipcMain.handle(
    "missionControl:userStories:nudge",
    (_event, userStoryId: string, text: string) =>
      userStoryRunner.nudgeUserStory(userStoryId, text)
  )
  ipcMain.handle(
    "missionControl:userStories:cancel",
    (_event, userStoryId: string) =>
      userStoryRunner.cancelUserStory(userStoryId)
  )
  ipcMain.handle(
    "missionControl:hooks:run",
    (
      _event,
      input: {
        featureId: string
        milestoneId?: string | null
        hook: PlaybookHookName
      }
    ) => startHookRun(userStoryRunner, input)
  )

  ipcMain.handle("missionControl:features:list", () => features.listFeatures())
  ipcMain.handle("missionControl:features:get", (_event, id: string) =>
    features.getFeatureGraph(id)
  )
  ipcMain.handle("missionControl:features:create", (_event, input) =>
    features.createFeature(input)
  )
  ipcMain.handle(
    "missionControl:features:update",
    (_event, id: string, patch, actor?: string, reason?: string) =>
      features.updateFeature(id, patch, actor, reason)
  )
  ipcMain.handle(
    "missionControl:features:delete",
    async (_event, id: string) => {
      // Seat sessions are hidden conversations the cascade does not reach.
      const conversations = seatSessionsRepo
        .listSeatSessions({ featureId: id })
        .map((session) => session.conversationId)
        .filter((cid): cid is string => !!cid)
      if (
        playbooks.listPlaybookRuns({ featureId: id, status: "running" }).length
      )
        throw new Error("A playbook run is in progress here. Cancel it first.")
      // Worktrees and mc/ branches go first, while the rows naming them exist.
      const { keptBranches } = await integration.cleanupFeature(id)
      features.deleteFeature(id)
      seatSessions.cancelFeature(id)
      await deleteConversationsWithArtifacts(conversations)
      return { keptBranches }
    }
  )
  // Starting through the Navigator in the feature's chosen drive mode.
  ipcMain.handle(
    "missionControl:features:start",
    async (_event, id: string) => {
      const feature = features.getFeature(id)
      if (!feature) throw new Error(`Feature not found: ${id}`)
      // No review sheet on this path: start with what's safe.
      const checked = await preflight(id, false, true)
      if (checked.blocked)
        throw new Error(
          "The workspace needs your input before this feature can start. Open the feature to see what to fix."
        )
      await navigator.startDrive(id, {
        mode: feature.driveMode,
        autoApplyPlan: feature.drive.autoApplyPlan,
      })
      return graphOf(id)
    }
  )
  ipcMain.handle(
    "missionControl:features:reseat",
    (_event, id: string, reason?: string) => {
      const graph = features.reseatFeature(id, reason)
      // A re-seat starts every live seat session's next generation against
      // the new snapshot (plan 106.4 decision 2).
      seatSessions.rotateFeature(id, "The rig was re-seated")
      return graph
    }
  )
  ipcMain.handle("missionControl:milestones:create", (_event, input) =>
    features.createMilestone(input)
  )
  ipcMain.handle(
    "missionControl:milestones:update",
    (_event, id: string, patch, actor?: string, reason?: string) =>
      features.updateMilestone(id, patch, actor, reason)
  )
  ipcMain.handle(
    "missionControl:milestones:delete",
    (_event, id: string, actor?: string, reason?: string) =>
      features.deleteMilestone(id, actor, reason)
  )
  // The renderer creates user user stories only: origin and actor are not its to set.
  ipcMain.handle(
    "missionControl:userStories:create",
    (
      _event,
      input: {
        milestoneId: string
        key: string
        title: string
        spec?: Parameters<typeof features.createUserStory>[0]["spec"]
        podKey?: string | null
      }
    ) =>
      features.createUserStory({
        milestoneId: input.milestoneId,
        key: input.key,
        title: input.title,
        spec: input.spec,
        podKey: input.podKey,
      })
  )
  ipcMain.handle(
    "missionControl:userStories:update",
    (_event, id: string, patch, actor?: string, reason?: string) =>
      features.updateUserStory(id, patch, actor, reason)
  )
  ipcMain.handle(
    "missionControl:userStories:delete",
    (_event, id: string, actor?: string, reason?: string) => {
      const milestoneId = features.getUserStory(id)?.milestoneId
      const graph = features.deleteUserStory(id, actor, reason)
      if (!milestoneId) return graph
      // Removing the last unfinished user story can complete the milestone's work.
      integration.advanceMilestone(milestoneId)
      return features.getFeatureGraph(graph.feature.id) ?? graph
    }
  )
  ipcMain.handle(
    "missionControl:userStoryEdges:set",
    (_event, milestoneId: string, edges, actor?: string, reason?: string) =>
      features.setUserStoryEdges(milestoneId, edges, actor, reason)
  )
  ipcMain.handle("missionControl:revisions:list", (_event, featureId: string) =>
    features.listRevisions(featureId)
  )

  ipcMain.handle("missionControl:rigs:list", () => rigs.listRigs())
  ipcMain.handle("missionControl:rigs:get", (_event, id: string) => {
    const graph = rigs.getRigGraph(id)
    return graph ? { ...graph, diagnostics: rigs.diagnoseRig(graph) } : null
  })
  ipcMain.handle("missionControl:rigs:create", (_event, input) =>
    rigs.createRig(input)
  )
  ipcMain.handle("missionControl:rigs:update", (_event, id: string, patch) =>
    rigs.updateRig(id, patch)
  )
  ipcMain.handle("missionControl:rigs:delete", (_event, id: string) =>
    rigs.deleteRig(id)
  )
  ipcMain.handle(
    "missionControl:rigs:duplicate",
    (_event, id: string, name?: string) => rigs.duplicateRig(id, name)
  )

  ipcMain.handle("missionControl:pods:create", (_event, input) =>
    rigs.createPod(input)
  )
  ipcMain.handle("missionControl:pods:update", (_event, id: string, patch) =>
    rigs.updatePod(id, patch)
  )
  ipcMain.handle("missionControl:pods:delete", (_event, id: string) =>
    rigs.deletePod(id)
  )
  ipcMain.handle(
    "missionControl:pods:reorder",
    (_event, rigId: string, ids: string[]) => rigs.reorderPods(rigId, ids)
  )

  ipcMain.handle("missionControl:seats:create", (_event, input) =>
    rigs.createSeat(input)
  )
  ipcMain.handle("missionControl:seats:update", (_event, id: string, patch) =>
    rigs.updateSeat(id, patch)
  )
  ipcMain.handle("missionControl:seats:delete", (_event, id: string) =>
    rigs.deleteSeat(id)
  )
  ipcMain.handle(
    "missionControl:seats:reorder",
    (_event, podId: string, ids: string[]) => rigs.reorderSeats(podId, ids)
  )
  ipcMain.handle(
    "missionControl:oversight:set",
    (_event, rigId: string, edges) => rigs.setOversight(rigId, edges)
  )

  ipcMain.handle(
    "missionControl:rigs:export",
    async (
      _event,
      id: string,
      workspace?: string,
      exportOptions?: { includeMemories?: boolean }
    ) => {
      const graph = rigs.getRigGraph(id)
      if (!graph) throw new Error(`Rig not found: ${id}`)
      const exported = buildRigExport(graph, await agents(workspace), {
        includeMemories: exportOptions?.includeMemories === true,
      })
      const safeName = graph.rig.name
        .trim()
        .replace(/[^a-z0-9._ -]+/gi, "-")
        .slice(0, 80)
      const win = BrowserWindow.getFocusedWindow() ?? undefined
      const options = {
        title: "Save rig as template",
        defaultPath: `${safeName || "rig"}.rig.json`,
        filters: [{ name: "Rig template", extensions: ["json"] }],
      }
      const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return { canceled: true }
      await writeFile(
        result.filePath,
        `${JSON.stringify(exported, null, 2)}\n`,
        "utf-8"
      )
      return { canceled: false, path: result.filePath }
    }
  )

  ipcMain.handle(
    "missionControl:rigs:import",
    async (_event, workspace?: string) => {
      const win = BrowserWindow.getFocusedWindow() ?? undefined
      const options: OpenDialogOptions = {
        title: "Import rig template",
        properties: ["openFile"],
        filters: [{ name: "Rig template", extensions: ["json"] }],
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || !result.filePaths[0]) return { canceled: true }
      const value = JSON.parse(
        await readFile(result.filePaths[0], "utf-8")
      ) as RigExport
      return {
        canceled: false,
        ...importRigExport(value, await agents(workspace)),
      }
    }
  )
}
