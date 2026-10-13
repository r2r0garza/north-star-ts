import * as processes from "../db/repositories/processes"
import { resolveCommandConfig } from "../../shared/process-command"
import type {
  ProcessGraph,
  ResolvedProcessCommand,
  Workspace,
  WorkspaceChecks,
} from "../db/types"

// Workspace checks for command phases (plan 104). A process names checks
// (`test`, `build`, …) and each workspace says what they run, so one process or
// playbook works across projects. Resolution happens when a run starts; there
// are no defaults, so a missing check stops the run before any phase runs.

// The sub-process nesting bound (mirrors the scheduler's MAX_PROCESS_DEPTH).
const MAX_DEPTH = 5

// Every check a process needs, including those of the sub-processes it runs.
export function requiredChecks(processId: string): string[] {
  const names = new Set<string>()
  const seen = new Set<string>()
  const visit = (id: string, depth: number) => {
    if (seen.has(id) || depth > MAX_DEPTH) return
    seen.add(id)
    for (const phase of processes.listPhases(id)) {
      if (phase.kind === "command" && phase.commandConfig?.source === "check")
        names.add(phase.commandConfig.check)
      if (phase.subprocessId) visit(phase.subprocessId, depth + 1)
    }
  }
  visit(processId, 0)
  return [...names].sort()
}

export interface CommandCheckStatus {
  required: string[]
  missing: string[]
  checks: WorkspaceChecks
}

export function commandCheckStatus(
  processId: string,
  workspace: Workspace | undefined
): CommandCheckStatus {
  const required = requiredChecks(processId)
  const checks = workspace?.commandChecks ?? {}
  return {
    required,
    missing: required.filter((name) => !checks[name]),
    checks,
  }
}

export class MissingChecksError extends Error {
  constructor(
    readonly missing: string[],
    workspaceLabel: string | null
  ) {
    super(missingChecksMessage(missing, workspaceLabel))
    this.name = "MissingChecksError"
  }
}

export function missingChecksMessage(
  missing: string[],
  workspaceLabel: string | null
): string {
  const list = missing.map((name) => `“${name}”`).join(", ")
  if (!workspaceLabel)
    return `This process runs workspace checks (${list}), so it needs a workspace folder.`
  return (
    `${workspaceLabel} doesn't define ${missing.length === 1 ? "the check" : "the checks"} ${list} this process runs. ` +
    "Define them when you start the run, or in a Mission Control feature's advanced settings."
  )
}

// The frozen command for every command phase in a graph. A phase whose stored
// config didn't parse is left out; the engine fails it at dispatch.
export function resolveRunCommands(
  graph: ProcessGraph,
  checks: WorkspaceChecks
):
  | { snapshot: Record<string, ResolvedProcessCommand> }
  | { missing: string[] } {
  const snapshot: Record<string, ResolvedProcessCommand> = {}
  const missing = new Set<string>()
  for (const phase of graph.phases) {
    if (phase.kind !== "command" || !phase.commandConfig) continue
    const resolved = resolveCommandConfig(phase.commandConfig, checks)
    if ("missing" in resolved) missing.add(resolved.missing)
    else snapshot[phase.id] = resolved
  }
  return missing.size > 0 ? { missing: [...missing].sort() } : { snapshot }
}
