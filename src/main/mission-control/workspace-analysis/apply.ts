import path from "path"
import type {
  GeneratedFilesRule,
  WorktreeSetup,
  WorktreeSetupStep,
} from "../../db/types"
import type { WorkspaceSettingsPatch } from "../../../shared/mission-control/workspace-analysis"
import { ruleCovered } from "./assemble"
import {
  checkGeneratedCommand,
  checkGlob,
  checkRelativePath,
  checkSetupCommand,
} from "./policy"

// Applying a finding's settings patch (plan 106.11): validate everything
// again in the main process (the patch came from our own stored analysis,
// but a model finding passes through here too), then merge it into the
// workspace's worktree setup and generated-file rules. Never drops or edits
// what the user wrote unless the patch removes it explicitly.

export interface WorkspaceSettings {
  worktreeSetup: WorktreeSetup
  generatedFiles: GeneratedFilesRule[]
}

// Setup steps run in this order: toolchains, dependencies, code generation,
// databases; the user's own steps keep their place.
function rank(step: WorktreeSetupStep): number {
  if (step.source === "user") return 1.5
  if (/:toolchain/.test(step.id)) return 0
  if (/:env:/.test(step.id)) return 1
  if (/:gen/.test(step.id)) return 2
  if (/:database:/.test(step.id)) return 3
  return 2.5
}

export function validatePatch(
  patch: WorkspaceSettingsPatch,
  workspace: string
): string | null {
  for (const p of [
    ...(patch.worktreeLinkPaths?.add ?? []),
    ...(patch.worktreeLinkPaths?.remove ?? []),
  ]) {
    const v = checkRelativePath(p)
    if (!v.ok) return `${p}: ${v.reason}`
  }
  for (const step of patch.worktreeSetupSteps?.add ?? []) {
    const dir = checkRelativePath(step.cwd)
    if (!dir.ok) return `${step.cwd}: ${dir.reason}`
    // A built-in step isn't a shell command; the commands it may run are.
    const commands =
      step.kind === "python-shared-venv"
        ? [...(step.fallback ?? []), ...(step.refresh ?? [])].map(
            (c) => c.command
          )
        : [step.command]
    if (step.kind === "python-shared-venv") {
      const venv = checkRelativePath(step.venv ?? ".venv")
      if (!venv.ok) return `${step.venv}: ${venv.reason}`
    }
    for (const command of commands) {
      const v = checkSetupCommand(command, path.join(workspace, step.cwd))
      if (!v.ok) return `\`${command}\`: ${v.reason}`
    }
  }
  for (const rule of patch.generatedFiles?.add ?? []) {
    for (const glob of rule.paths) {
      const v = checkGlob(glob)
      if (!v.ok) return `${glob}: ${v.reason}`
    }
    const v = checkGeneratedCommand(rule.command, workspace)
    if (!v.ok) return `\`${rule.command}\`: ${v.reason}`
  }
  return null
}

export function applyPatch(
  current: WorkspaceSettings,
  patch: WorkspaceSettingsPatch,
  findingKey: string
): WorkspaceSettings {
  const remove = new Set(patch.worktreeLinkPaths?.remove ?? [])
  const linkPaths = [
    ...current.worktreeSetup.linkPaths.filter((p) => !remove.has(p)),
    ...(patch.worktreeLinkPaths?.add ?? []).filter(
      (p) => !current.worktreeSetup.linkPaths.includes(p)
    ),
  ]
  const removeSteps = new Set(patch.worktreeSetupSteps?.remove ?? [])
  const adding = patch.worktreeSetupSteps?.add ?? []
  // Re-applying a finding replaces the steps it saved before (an older
  // recipe's commands), unless the user edited them (then they're "user").
  let steps = current.worktreeSetup.steps.filter(
    (s) =>
      !removeSteps.has(s.id) &&
      !(
        adding.length &&
        s.source === "analysis" &&
        s.findingKey === findingKey &&
        !adding.some(
          (a) => a.command.trim() === s.command.trim() && a.cwd === s.cwd
        )
      )
  )
  for (const step of patch.worktreeSetupSteps?.add ?? []) {
    if (
      steps.some(
        (s) => s.command.trim() === step.command.trim() && s.cwd === step.cwd
      )
    )
      continue
    let id = step.id
    while (steps.some((s) => s.id === id)) id = `${step.id}-${steps.length}`
    const added: WorktreeSetupStep = {
      id,
      label: step.label,
      command: step.command,
      cwd: step.cwd,
      source: "analysis",
      findingKey,
      ...(step.kind === "python-shared-venv"
        ? {
            kind: step.kind,
            venv: step.venv ?? ".venv",
            fallback: step.fallback ?? [],
            refresh: step.refresh ?? [],
          }
        : {}),
    }
    // Insert after the last step of the same or an earlier rank.
    const at = steps.reduce(
      (last, s, i) => (rank(s) <= rank(added) ? i + 1 : last),
      0
    )
    steps = [...steps.slice(0, at), added, ...steps.slice(at)]
  }
  const generatedFiles = current.generatedFiles.map((r) => ({
    ...r,
    paths: [...r.paths],
  }))
  for (const rule of patch.generatedFiles?.add ?? []) {
    const covered = ruleCovered(
      { linkPaths: [], steps: [], generatedFiles, overlapPolicy: "wait" },
      rule
    )
    if (covered) continue
    const sameCommand = generatedFiles.find(
      (r) => r.command.trim() === rule.command.trim()
    )
    if (sameCommand)
      sameCommand.paths = [...new Set([...sameCommand.paths, ...rule.paths])]
    else generatedFiles.push({ paths: [...rule.paths], command: rule.command })
  }
  return { worktreeSetup: { linkPaths, steps }, generatedFiles }
}
