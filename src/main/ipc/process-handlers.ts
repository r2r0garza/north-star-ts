import { ipcMain } from "electron"
import type { TaskRunner } from "../tasks/runner"
import type { ProcessService } from "../tasks/process/service"
import { getProcessRun } from "../db/repositories/processes"

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

  // Approve a phase gate. A process gate has no in-memory agent promise (the
  // scheduler threw and unwound, settling the task `paused`), so unlike
  // task:approve we don't touch the agent gate resolver — we settle the durable
  // approval row (recordApprovalDecision) and RESUME the paused task, which
  // re-runs the scheduler; it sees the gate approved and releases the dependents.
  ipcMain.handle(
    "process:approve",
    (
      _e,
      payload: {
        processRunId: string
        requestId: string
      }
    ) => {
      const run = getProcessRun(payload.processRunId)
      if (!run?.taskId) return
      runner.recordApprovalDecision(run.taskId, payload.requestId, "approved")
      runner.resume(run.taskId)
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
}
