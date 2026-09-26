import { readFile, writeFile } from "fs/promises"
import {
  BrowserWindow,
  dialog,
  ipcMain,
  type OpenDialogOptions,
} from "electron"
import { agentSources } from "../agent/agents/sources"
import { loadAgents } from "../agent/agents/loader"
import * as rigs from "../db/repositories/rigs"
import * as initiatives from "../db/repositories/initiatives"
import * as playbooks from "../db/repositories/playbooks"
import {
  buildRigExport,
  importRigExport,
  type RigExport,
} from "../mission-control/io"
import { createDefaultPlaybook } from "../mission-control/playbook-defaults"
import type { SliceRunner } from "../mission-control/slice-runner"
import type { SeatComms } from "../mission-control/comms"
import type { SeatSessionService } from "../mission-control/sessions"
import * as seatCommsRepo from "../db/repositories/seat-comms"
import * as seatSessionsRepo from "../db/repositories/seat-sessions"
import { deleteConversationsWithArtifacts } from "../conversations/lifecycle"
import { startHookRun } from "../mission-control/hook-runner"
import type { MissionIntegration } from "../mission-control/integration"
import type { Navigator } from "../mission-control/navigator"
import {
  applyProposal,
  checkProposal,
  judgeMissionDone,
  rejectProposal,
} from "../mission-control/map-tools"
import * as proposalsRepo from "../db/repositories/proposals"
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
  sliceRunner: SliceRunner,
  seatComms: SeatComms,
  seatSessions: SeatSessionService,
  integration: MissionIntegration,
  navigator: Navigator,
  // Open a folder in the user's IDE (settings), for slice worktrees.
  openFolder: (folder: string) => Promise<string>
): void {
  const graphOf = (id: string) => {
    const graph = initiatives.getInitiativeGraph(id)
    if (!graph) throw new Error(`Feature not found: ${id}`)
    return graph
  }

  // The Navigator and drive controls (plan 106.6). Budgets and the drive
  // mode are the user's alone: no tool reaches these handlers.
  ipcMain.handle(
    "missionControl:drive:start",
    async (_event, id: string, options: { mode: DriveMode; autoApplyPlan?: boolean }) => {
      const started = await navigator.startDrive(id, {
        mode: options?.mode ?? "manual",
        autoApplyPlan: options?.autoApplyPlan === true,
      })
      return { graph: graphOf(id), planningError: started.planningError }
    }
  )
  ipcMain.handle("missionControl:drive:pause", (_event, id: string, reason?: string) => {
    navigator.pause(id, reason?.trim() || "Paused by the user", "user")
    return graphOf(id)
  })
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
  ipcMain.handle("missionControl:drive:setMode", (_event, id: string, mode: DriveMode) => {
    navigator.setMode(id, mode)
    return graphOf(id)
  })
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
      initiatives.setInitiativeBudgets(id, patch ?? {}, "user")
      return graphOf(id)
    }
  )
  ipcMain.handle("missionControl:navigator:position", (_event, id: string) =>
    navigator.position(id)
  )
  ipcMain.handle(
    "missionControl:navigator:ticks",
    (_event, id: string, limit?: number) => navigatorTicks.listTicks(id, limit ?? 50)
  )
  // Rejections and partial applications go back to the seat that proposed,
  // in the user's words.
  const deliverToProposer = (
    resolved: { initiativeId: string; proposer: string },
    body: string,
    subject: string
  ) => {
    if (!parseSeatAddress(resolved.proposer)) return
    const result = seatComms.userNote({
      initiativeId: resolved.initiativeId,
      to: resolved.proposer,
      body,
      subject,
    })
    if (!result.ok) console.warn("[proposals] note not delivered:", result.message)
  }
  // Pending proposals carry which of their changes no longer apply.
  ipcMain.handle("missionControl:proposals:list", (_event, initiativeId: string) =>
    proposalsRepo
      .listProposals(initiativeId)
      .map((proposal) =>
        proposal.status === "pending"
          ? { ...proposal, problems: checkProposal(proposal) }
          : proposal
      )
  )
  ipcMain.handle(
    "missionControl:proposals:apply",
    (_event, id: string, options?: { partial?: boolean }) => {
      const proposal = applyProposal(id, "user", {
        partial: options?.partial === true,
        deliver: (resolved, body) => deliverToProposer(resolved, body, "Proposal partly applied"),
      })
      return graphOf(proposal.initiativeId)
    }
  )
  // The user's definition-of-done judgment for a mission.
  ipcMain.handle(
    "missionControl:missions:judgeDone",
    async (_event, missionId: string, summary: string) => {
      await judgeMissionDone(missionId, summary ?? "", async (id) => {
        await integration.markMerged(id)
      })
      const mission = initiatives.getMission(missionId)
      return graphOf(mission!.initiativeId)
    }
  )
  ipcMain.handle(
    "missionControl:proposals:reject",
    (_event, id: string, note?: string) => {
      const proposal = rejectProposal(id, note ?? "", (resolved, body) =>
        deliverToProposer(resolved, body, "Proposal rejected")
      )
      return graphOf(proposal.initiativeId)
    }
  )
  ipcMain.handle("missionControl:comms:acknowledge", (_event, messageId: string) =>
    seatComms.acknowledge(messageId)
  )
  ipcMain.handle(
    "missionControl:comms:reply",
    (_event, messageId: string, body: string) => {
      const result = seatComms.userReply(messageId, body ?? "")
      if (!result.ok) throw new Error(result.message)
      return result.message
    }
  )
  // Mission integration (plan 106.5). Landing is the one call that may change
  // the user's branch, and only with the base/head the user reviewed.
  ipcMain.handle("missionControl:integration:status", (_event, missionId: string) =>
    integration.status(missionId)
  )
  ipcMain.handle(
    "missionControl:integration:setPolicy",
    (_event, missionId: string, mode: MergePolicyMode) =>
      initiatives.setMissionMergePolicy(missionId, mode)
  )
  ipcMain.handle(
    "missionControl:integration:land",
    (
      _event,
      missionId: string,
      approval: { baseOid: string; headOid: string },
      options?: { localMerge?: boolean }
    ) => {
      if (typeof approval?.baseOid !== "string" || typeof approval?.headOid !== "string")
        throw new Error("Review the merge before approving it.")
      return integration.land(missionId, approval, {
        localMerge: options?.localMerge === true,
      })
    }
  )
  ipcMain.handle("missionControl:integration:markMerged", (_event, missionId: string) =>
    integration.markMerged(missionId)
  )
  ipcMain.handle("missionControl:integration:retry", (_event, entryId: string) =>
    integration.retry(entryId)
  )
  ipcMain.handle("missionControl:integration:resolve", (_event, entryId: string) =>
    integration.resolve(entryId)
  )
  ipcMain.handle("missionControl:integration:abandon", (_event, entryId: string) =>
    integration.abandon(entryId)
  )
  ipcMain.handle("missionControl:integration:sliceInfo", (_event, sliceId: string) =>
    integration.info(sliceId)
  )
  ipcMain.handle("missionControl:integration:sliceDiff", (_event, sliceId: string) =>
    integration.sliceDiff(sliceId)
  )
  ipcMain.handle(
    "missionControl:integration:openWorktree",
    async (_event, sliceId: string) => {
      const info = integration.info(sliceId)
      if (!info.exists || !info.workspacePath)
        return "This user story has no worktree right now."
      return openFolder(info.workspacePath)
    }
  )

  // Comms and seat sessions (plan 106.4). Agent threads are read-only here: the
  // user's only write is an explicit Steer, sent from user@rig.
  ipcMain.handle("missionControl:comms:list", (_event, initiativeId: string) => ({
    threads: seatCommsRepo.listThreads(initiativeId),
    messages: seatCommsRepo.listMessages({ initiativeId, limit: 2000 }),
  }))
  ipcMain.handle("missionControl:comms:seats", (_event, initiativeId: string) =>
    seatSessions.overview(initiativeId)
  )
  ipcMain.handle(
    "missionControl:comms:steer",
    (
      _event,
      input: { initiativeId: string; to: string; body: string; direct?: boolean }
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
  ipcMain.handle(
    "missionControl:playbooks:update",
    (_event, id: string, patch: { name?: string; description?: string | null }) =>
      playbooks.updatePlaybook(id, patch)
  )
  ipcMain.handle("missionControl:playbooks:delete", (_event, id: string) =>
    playbooks.deletePlaybook(id)
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
        initiativeId?: string
        missionId?: string
        sliceId?: string
        status?: PlaybookRunStatus
      }
    ) => playbooks.listPlaybookRuns(filter)
  )
  ipcMain.handle(
    "missionControl:playbookRuns:cancel",
    (_event, id: string) => sliceRunner.cancelPlaybookRun(id)
  )
  ipcMain.handle(
    "missionControl:slices:run",
    (_event, sliceId: string, options?: { allowTouchOverlap?: boolean }) =>
      sliceRunner.startSlice(sliceId, {
        allowTouchOverlap: options?.allowTouchOverlap === true,
        actor: "user",
      })
  )
  ipcMain.handle("missionControl:slices:cancel", (_event, sliceId: string) =>
    sliceRunner.cancelSlice(sliceId)
  )
  ipcMain.handle(
    "missionControl:hooks:run",
    (
      _event,
      input: {
        initiativeId: string
        missionId?: string | null
        hook: PlaybookHookName
      }
    ) => startHookRun(sliceRunner, input)
  )

  ipcMain.handle("missionControl:initiatives:list", () =>
    initiatives.listInitiatives()
  )
  ipcMain.handle("missionControl:initiatives:get", (_event, id: string) =>
    initiatives.getInitiativeGraph(id)
  )
  ipcMain.handle("missionControl:initiatives:create", (_event, input) =>
    initiatives.createInitiative(input)
  )
  ipcMain.handle(
    "missionControl:initiatives:update",
    (_event, id: string, patch, actor?: string, reason?: string) =>
      initiatives.updateInitiative(id, patch, actor, reason)
  )
  ipcMain.handle("missionControl:initiatives:delete", async (_event, id: string) => {
    // Seat sessions are hidden conversations the cascade does not reach.
    const conversations = seatSessionsRepo
      .listSeatSessions({ initiativeId: id })
      .map((session) => session.conversationId)
      .filter((cid): cid is string => !!cid)
    if (playbooks.listPlaybookRuns({ initiativeId: id, status: "running" }).length)
      throw new Error("A playbook run is in progress here. Cancel it first.")
    // Worktrees and mc/ branches go first, while the rows naming them exist.
    const { keptBranches } = await integration.cleanupInitiative(id)
    initiatives.deleteInitiative(id)
    seatSessions.cancelInitiative(id)
    await deleteConversationsWithArtifacts(conversations)
    return { keptBranches }
  })
  // Starting through the Navigator in the initiative's chosen drive mode.
  ipcMain.handle("missionControl:initiatives:start", async (_event, id: string) => {
    const initiative = initiatives.getInitiative(id)
    if (!initiative) throw new Error(`Feature not found: ${id}`)
    await navigator.startDrive(id, {
      mode: initiative.driveMode,
      autoApplyPlan: initiative.drive.autoApplyPlan,
    })
    return graphOf(id)
  })
  ipcMain.handle(
    "missionControl:initiatives:reseat",
    (_event, id: string, reason?: string) => {
      const graph = initiatives.reseatInitiative(id, reason)
      // A re-seat starts every live seat session's next generation against
      // the new snapshot (plan 106.4 decision 2).
      seatSessions.rotateInitiative(id, "The rig was re-seated")
      return graph
    }
  )
  ipcMain.handle("missionControl:missions:create", (_event, input) =>
    initiatives.createMission(input)
  )
  ipcMain.handle(
    "missionControl:missions:update",
    (_event, id: string, patch, actor?: string, reason?: string) =>
      initiatives.updateMission(id, patch, actor, reason)
  )
  ipcMain.handle(
    "missionControl:missions:delete",
    (_event, id: string, actor?: string, reason?: string) =>
      initiatives.deleteMission(id, actor, reason)
  )
  // The renderer creates user slices only: origin and actor are not its to set.
  ipcMain.handle(
    "missionControl:slices:create",
    (
      _event,
      input: {
        missionId: string
        key: string
        title: string
        spec?: Parameters<typeof initiatives.createSlice>[0]["spec"]
        podKey?: string | null
      }
    ) =>
      initiatives.createSlice({
        missionId: input.missionId,
        key: input.key,
        title: input.title,
        spec: input.spec,
        podKey: input.podKey,
      })
  )
  ipcMain.handle(
    "missionControl:slices:update",
    (_event, id: string, patch, actor?: string, reason?: string) =>
      initiatives.updateSlice(id, patch, actor, reason)
  )
  ipcMain.handle(
    "missionControl:slices:delete",
    (_event, id: string, actor?: string, reason?: string) => {
      const missionId = initiatives.getSlice(id)?.missionId
      const graph = initiatives.deleteSlice(id, actor, reason)
      if (!missionId) return graph
      // Removing the last unfinished slice can complete the mission's work.
      integration.advanceMission(missionId)
      return initiatives.getInitiativeGraph(graph.initiative.id) ?? graph
    }
  )
  ipcMain.handle(
    "missionControl:sliceEdges:set",
    (_event, missionId: string, edges, actor?: string, reason?: string) =>
      initiatives.setSliceEdges(missionId, edges, actor, reason)
  )
  ipcMain.handle(
    "missionControl:revisions:list",
    (_event, initiativeId: string) => initiatives.listRevisions(initiativeId)
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
    async (_event, id: string, workspace?: string) => {
      const graph = rigs.getRigGraph(id)
      if (!graph) throw new Error(`Rig not found: ${id}`)
      const exported = buildRigExport(graph, await agents(workspace))
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
