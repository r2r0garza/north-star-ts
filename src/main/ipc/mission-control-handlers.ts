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
import { buildRigExport, importRigExport, type RigExport } from "../mission-control/io"

async function agents(workspace?: string) {
  return loadAgents(agentSources(workspace))
}

export function registerMissionControlHandlers(): void {
  ipcMain.handle("missionControl:rigs:list", () => rigs.listRigs())
  ipcMain.handle("missionControl:rigs:get", (_event, id: string) => {
    const graph = rigs.getRigGraph(id)
    return graph ? { ...graph, diagnostics: rigs.diagnoseRig(graph) } : null
  })
  ipcMain.handle("missionControl:rigs:create", (_event, input) => rigs.createRig(input))
  ipcMain.handle("missionControl:rigs:update", (_event, id: string, patch) => rigs.updateRig(id, patch))
  ipcMain.handle("missionControl:rigs:delete", (_event, id: string) => rigs.deleteRig(id))
  ipcMain.handle("missionControl:rigs:duplicate", (_event, id: string, name?: string) => rigs.duplicateRig(id, name))

  ipcMain.handle("missionControl:pods:create", (_event, input) => rigs.createPod(input))
  ipcMain.handle("missionControl:pods:update", (_event, id: string, patch) => rigs.updatePod(id, patch))
  ipcMain.handle("missionControl:pods:delete", (_event, id: string) => rigs.deletePod(id))
  ipcMain.handle("missionControl:pods:reorder", (_event, rigId: string, ids: string[]) => rigs.reorderPods(rigId, ids))

  ipcMain.handle("missionControl:seats:create", (_event, input) => rigs.createSeat(input))
  ipcMain.handle("missionControl:seats:update", (_event, id: string, patch) => rigs.updateSeat(id, patch))
  ipcMain.handle("missionControl:seats:delete", (_event, id: string) => rigs.deleteSeat(id))
  ipcMain.handle("missionControl:seats:reorder", (_event, podId: string, ids: string[]) => rigs.reorderSeats(podId, ids))
  ipcMain.handle("missionControl:oversight:set", (_event, rigId: string, edges) => rigs.setOversight(rigId, edges))

  ipcMain.handle("missionControl:rigs:export", async (_event, id: string, workspace?: string) => {
    const graph = rigs.getRigGraph(id)
    if (!graph) throw new Error(`Rig not found: ${id}`)
    const exported = buildRigExport(graph, await agents(workspace))
    const safeName = graph.rig.name.trim().replace(/[^a-z0-9._ -]+/gi, "-").slice(0, 80)
    const win = BrowserWindow.getFocusedWindow() ?? undefined
    const options = {
      title: "Save rig as template",
      defaultPath: `${safeName || "rig"}.rig.json`,
      filters: [{ name: "Rig template", extensions: ["json"] }],
    }
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { canceled: true }
    await writeFile(result.filePath, `${JSON.stringify(exported, null, 2)}\n`, "utf-8")
    return { canceled: false, path: result.filePath }
  })

  ipcMain.handle("missionControl:rigs:import", async (_event, workspace?: string) => {
    const win = BrowserWindow.getFocusedWindow() ?? undefined
    const options: OpenDialogOptions = {
      title: "Import rig template",
      properties: ["openFile"],
      filters: [{ name: "Rig template", extensions: ["json"] }],
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return { canceled: true }
    const value = JSON.parse(await readFile(result.filePaths[0], "utf-8")) as RigExport
    return { canceled: false, ...importRigExport(value, await agents(workspace)) }
  })
}
