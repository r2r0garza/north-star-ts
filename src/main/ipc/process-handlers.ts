import { readFile, writeFile } from "fs/promises"
import { basename } from "path"
import {
  BrowserWindow,
  dialog,
  ipcMain,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from "electron"
import type { TaskRunner } from "../tasks/runner"
import type { ProcessService } from "../tasks/process/service"
import { getProcessRun } from "../db/repositories/processes"
import {
  exportProcessDefinition,
  importProcessExport,
  type ProcessImportResult,
} from "../process/io"

// Control channels for the Process engine (plan 025). Definition/run CRUD lives
// on the `db:processes:*` channels (db-handlers.ts); these are the *control verbs*
// that drive the runner. Process runs stream their phase transitions on the
// existing `task:event` tail (they ride the process_run task), so there is no new
// event channel — the 026 monitor reuses task:subscribe and filters process_phase
// events by the run's task id. Call after the runner + ProcessService are built.
export function registerProcessHandlers(
  runner: TaskRunner,
  processService: ProcessService
): void {
  // Start a new run of a definition. Returns the created ProcessRun.
  ipcMain.handle(
    "process:startRun",
    (
      _e,
      input: {
        processId: string
        sourceConversationId: string | null
        objective: string
        workspacePath?: string | null
      }
    ) => processService.startRun(input)
  )

  // Cancel a run: abort its backing task (running phases observe the signal and
  // unwind). No-op if the run has no backing task (already settled).
  ipcMain.handle("process:cancel", (_e, processRunId: string) => {
    const run = getProcessRun(processRunId)
    if (run?.taskId) runner.cancel(run.taskId)
  })

  // Pause a run: pause its backing task (a durable resume state).
  ipcMain.handle("process:pause", (_e, processRunId: string) => {
    const run = getProcessRun(processRunId)
    if (run?.taskId) runner.pause(run.taskId)
  })

  // Retry a FAILED run from its failure frontier. Delegated to the service (it
  // needs the graph to reset the failed phase-runs correctly), which resets the
  // frontier and re-drives the same backing task.
  ipcMain.handle("process:restart", (_e, processRunId: string) =>
    processService.restartRun(processRunId)
  )

  // Approve a process gate. The service keeps normal phase approval and
  // validator manual override decisions distinct, then resumes the paused task so
  // the scheduler can reconcile the durable gate row.
  ipcMain.handle(
    "process:approve",
    (
      _e,
      payload: {
        processRunId: string
        requestId: string
      }
    ) => {
      processService.approve(payload)
    }
  )

  // Deny a phase gate. v1: settle the row denied and leave the run paused — the
  // gated phase's dependents stay blocked; the user can cancel the run. Richer
  // deny semantics (skip dependents / edit + continue) are deferred to 026.
  ipcMain.handle(
    "process:deny",
    (_e, payload: { processRunId: string; requestId: string }) => {
      const run = getProcessRun(payload.processRunId)
      if (!run?.taskId) return
      runner.recordApprovalDecision(run.taskId, payload.requestId, "denied")
    }
  )

  // Request changes on a phase gate (plan 029): the third decision. Delegated to
  // the service — it settles the gate denied (with the feedback), resets the gated
  // phase-run to re-run with the note, bumps the round counter, and resumes the
  // task. Throws (rejecting the invoke) on a container phase or at the rework cap.
  ipcMain.handle(
    "process:requestChanges",
    (
      _e,
      payload: { processRunId: string; requestId: string; feedback: string }
    ) => processService.requestChanges(payload)
  )

  // Retry only a failed validator review for a validator gate. The completed phase
  // worker output is reused; only the reviewer runs again.
  ipcMain.handle(
    "process:retryReview",
    (_e, payload: { processRunId: string; requestId: string }) =>
      processService.retryReview(payload)
  )

  // Confirm / dismiss a cross-phase rework flag (plan 031.2). Delegated to the
  // service: confirm applies the flag's reset (target + downstream) and resumes;
  // dismiss settles the flag denied and resumes as if unflagged.
  ipcMain.handle(
    "process:confirmFlag",
    (_e, payload: { processRunId: string; requestId: string }) =>
      processService.confirmFlag(payload)
  )
  ipcMain.handle(
    "process:dismissFlag",
    (_e, payload: { processRunId: string; requestId: string }) =>
      processService.dismissFlag(payload)
  )

  ipcMain.handle("process:export", async (_e, processId: string) => {
    const exported = exportProcessDefinition(processId)
    const safeName = exported.definition.name
      .trim()
      .replace(/[^a-z0-9._ -]+/gi, "-")
      .replace(/\s+/g, " ")
      .slice(0, 80)
    const win = BrowserWindow.getFocusedWindow() ?? undefined
    const options: SaveDialogOptions = {
      title: "Export process",
      defaultPath: `${safeName || "process"}.json`,
      filters: [{ name: "Process JSON", extensions: ["json"] }],
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
    return { path: result.filePath, canceled: false }
  })

  ipcMain.handle(
    "process:import",
    async (): Promise<
      | (ProcessImportResult & { path: string; canceled: false })
      | { canceled: true }
    > => {
      const win = BrowserWindow.getFocusedWindow() ?? undefined
      const options: OpenDialogOptions = {
        title: "Import process",
        properties: ["openFile"],
        filters: [{ name: "Process JSON", extensions: ["json"] }],
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true }
      }

      const path = result.filePaths[0]
      const raw = await readFile(path, "utf-8")
      const parsed = JSON.parse(raw) as unknown
      return {
        ...importProcessExport(parsed),
        path: basename(path),
        canceled: false,
      }
    }
  )
}
