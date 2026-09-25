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
import { startHookRun } from "../mission-control/hook-runner"
import type {
  PlaybookAltitude,
  PlaybookHookName,
  PlaybookRunStatus,
} from "../db/types"

async function agents(workspace?: string) {
  return loadAgents(agentSources(workspace))
}

export function registerMissionControlHandlers(sliceRunner: SliceRunner): void {
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
  ipcMain.handle("missionControl:slices:run", (_event, sliceId: string) =>
    sliceRunner.startSlice(sliceId)
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
  ipcMain.handle("missionControl:initiatives:delete", (_event, id: string) =>
    initiatives.deleteInitiative(id)
  )
  ipcMain.handle("missionControl:initiatives:start", (_event, id: string) =>
    initiatives.startInitiative(id)
  )
  ipcMain.handle(
    "missionControl:initiatives:reseat",
    (_event, id: string, reason?: string) =>
      initiatives.reseatInitiative(id, reason)
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
  ipcMain.handle("missionControl:slices:create", (_event, input) =>
    initiatives.createSlice(input)
  )
  ipcMain.handle(
    "missionControl:slices:update",
    (_event, id: string, patch, actor?: string, reason?: string) =>
      initiatives.updateSlice(id, patch, actor, reason)
  )
  ipcMain.handle(
    "missionControl:slices:delete",
    (_event, id: string, actor?: string, reason?: string) =>
      initiatives.deleteSlice(id, actor, reason)
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
