import { randomUUID } from "crypto"
import { existsSync } from "fs"
import {
  COMMAND_OUTPUT_DEFAULT_BYTES,
  COMMAND_TIMEOUT_DEFAULT_MS,
  parseWorkspaceCheck,
} from "../../shared/process-command"
import { executeProcessCommand } from "../tasks/process/command-executor"
import type { CommandExecutorDeps } from "../tasks/process/command-executor"
import type { ProcessCommandReceipt, WorkspaceCheck } from "../db/types"

// Try it (plan 104): run a check's command once, as the user typed it (saved
// or not), in its workspace, through the same executor, backend, and approval
// policy as a command phase. The user clicked with the command in view; only
// a hard-blocked command is refused. The result is shown, never stored.

export interface CommandTrial {
  id: string
  status: "running" | "passed" | "failed" | "cancelled"
  // The latest snapshot while running, then the final receipt. Null when the
  // command never started.
  receipt: ProcessCommandReceipt | null
  error: string | null
}

export class CommandTrialService {
  private readonly trials = new Map<
    string,
    { view: CommandTrial; abort: AbortController }
  >()

  constructor(private readonly deps: () => CommandExecutorDeps) {}

  start(input: {
    workspacePath: string
    check: WorkspaceCheck
    timeoutMs?: number
  }): CommandTrial {
    if (!existsSync(input.workspacePath))
      throw new Error("The workspace folder doesn't exist.")
    const check = parseWorkspaceCheck(input.check)
    const view: CommandTrial = {
      id: randomUUID(),
      status: "running",
      receipt: null,
      error: null,
    }
    const abort = new AbortController()
    this.trials.set(view.id, { view, abort })
    // Keep only recent trials.
    for (const id of [...this.trials.keys()].slice(0, -20))
      this.trials.delete(id)
    const update = (receipt: ProcessCommandReceipt) => {
      view.receipt = receipt
    }
    void executeProcessCommand(
      {
        config: {
          check: null,
          command: check.command,
          cwd: check.cwd,
          timeoutMs: input.timeoutMs ?? COMMAND_TIMEOUT_DEFAULT_MS,
          maxOutputBytes: COMMAND_OUTPUT_DEFAULT_BYTES,
        },
        workspace: input.workspacePath,
        phaseRunId: `trial-${view.id}`,
        signal: abort.signal,
        onStart: update,
        onProgress: update,
      },
      this.deps()
    )
      .then((result) => {
        view.receipt = result.receipt ?? view.receipt
        view.error = result.error ?? null
        view.status = result.stopped
          ? "cancelled"
          : !result.error &&
              result.receipt?.status === "completed" &&
              result.receipt.exitCode === 0
            ? "passed"
            : "failed"
      })
      .catch((err) => {
        view.status = "failed"
        view.error = err instanceof Error ? err.message : String(err)
      })
    return { ...view }
  }

  status(id: string): CommandTrial | null {
    const trial = this.trials.get(id)
    return trial ? { ...trial.view } : null
  }

  cancel(id: string): void {
    this.trials.get(id)?.abort.abort()
  }
}
