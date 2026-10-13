import { randomUUID } from "crypto"
import path from "path"
import {
  environmentFacts,
  type EnvironmentFact,
} from "../mission-control/workspace-analysis/analyze"
import { checkSetupCommand } from "../mission-control/workspace-analysis/policy"
import {
  toolEnv,
  warmShellPath,
} from "../mission-control/workspace-analysis/tool-env"

// Setting up a workspace's environment for its checks (plan 104). A check like
// `.venv/bin/python -m pytest` only passes once the project's environment
// exists; someone defining checks shouldn't need to know how to make one. The
// commands come from the workspace analysis recipes (never from the renderer
// or a model), pass the setup command policy, and run one at a time in the
// integrated terminal where the user watches. Command phases themselves never
// install anything.

export interface EnvironmentSetupStep {
  label: string
  command: string
  cwd: string
  status: "pending" | "running" | "ok" | "failed" | "skipped"
  exitCode: number | null
  sessionId: string | null
}

export interface EnvironmentSetupRun {
  id: string
  workspacePath: string
  status: "running" | "completed" | "failed" | "cancelled"
  steps: EnvironmentSetupStep[]
}

interface Terminals {
  runCommand(input: {
    ownerId: string
    cwd: string
    command: string
    title: string
    env?: Record<string, string>
  }): { id: string }
  kill(id: string): void
  on(
    event: "exit",
    listener: (e: { id: string; exitCode: number | null }) => void
  ): unknown
}

// The environments a workspace's checks need set up: missing or out of date.
export function needsSetup(fact: EnvironmentFact): boolean {
  return (
    (fact.status === "missing" || fact.status === "stale") &&
    fact.setup.length > 0
  )
}

export class EnvironmentSetupService {
  private readonly runs = new Map<string, EnvironmentSetupRun>()
  private readonly exits = new Map<string, (code: number | null) => void>()
  private readonly cancelled = new Set<string>()

  constructor(
    private readonly terminals: Terminals,
    private readonly facts: typeof environmentFacts = environmentFacts
  ) {
    terminals.on("exit", ({ id, exitCode }) => {
      const resolve = this.exits.get(id)
      if (!resolve) return
      this.exits.delete(id)
      resolve(exitCode)
    })
  }

  async start(workspacePath: string): Promise<EnvironmentSetupRun> {
    const workspace = path.resolve(workspacePath)
    if (
      [...this.runs.values()].some(
        (r) => r.workspacePath === workspace && r.status === "running"
      )
    )
      throw new Error("This workspace is already being set up.")
    const steps: EnvironmentSetupStep[] = []
    for (const fact of (await this.facts(workspace)).filter(needsSetup))
      for (const spec of fact.setup) {
        const cwdAbs = path.resolve(workspace, spec.cwd)
        const rel = path.relative(workspace, cwdAbs)
        if (rel.startsWith("..") || path.isAbsolute(rel))
          throw new Error(
            `${spec.label}: its directory is outside the workspace.`
          )
        const verdict = checkSetupCommand(spec.command, cwdAbs)
        if (!verdict.ok)
          throw new Error(`\`${spec.command}\` can't run: ${verdict.reason}`)
        steps.push({
          label: spec.label,
          command: spec.command,
          cwd: spec.cwd,
          status: "pending",
          exitCode: null,
          sessionId: null,
        })
      }
    if (steps.length === 0)
      throw new Error("This workspace's environment is already set up.")
    const run: EnvironmentSetupRun = {
      id: randomUUID(),
      workspacePath: workspace,
      status: "running",
      steps,
    }
    this.runs.set(run.id, run)
    void this.execute(run)
    return this.view(run)
  }

  status(runId: string): EnvironmentSetupRun | null {
    const run = this.runs.get(runId)
    return run ? this.view(run) : null
  }

  cancel(runId: string): void {
    const run = this.runs.get(runId)
    if (!run || run.status !== "running") return
    this.cancelled.add(runId)
    const active = run.steps.find((s) => s.status === "running")
    if (active?.sessionId) this.terminals.kill(active.sessionId)
  }

  private view(run: EnvironmentSetupRun): EnvironmentSetupRun {
    return { ...run, steps: run.steps.map((s) => ({ ...s })) }
  }

  private async execute(run: EnvironmentSetupRun): Promise<void> {
    await warmShellPath()
    const env = toolEnv()
    // The user is watching and can answer a prompt.
    delete env.CI
    delete env.GIT_TERMINAL_PROMPT
    let failed = false
    for (const step of run.steps) {
      if (failed || this.cancelled.has(run.id)) {
        step.status = "skipped"
        continue
      }
      step.status = "running"
      let sessionId: string
      try {
        sessionId = this.terminals.runCommand({
          ownerId: `process-setup:${run.workspacePath}`,
          cwd: path.resolve(run.workspacePath, step.cwd),
          command: step.command,
          title: step.label,
          env,
        }).id
      } catch {
        step.status = "failed"
        failed = true
        continue
      }
      step.sessionId = sessionId
      const exitCode = await new Promise<number | null>((resolve) =>
        this.exits.set(sessionId, resolve)
      )
      step.exitCode = exitCode
      step.status =
        exitCode === 0 && !this.cancelled.has(run.id) ? "ok" : "failed"
      if (step.status === "failed") failed = true
    }
    run.status = this.cancelled.has(run.id)
      ? "cancelled"
      : failed
        ? "failed"
        : "completed"
    this.cancelled.delete(run.id)
  }
}
