import type { AppService } from "./app-launch"

// Workspace setup findings (plan 106.11). Analysis inspects a Feature's
// workspace and returns a checklist: each finding names a concrete problem in
// plain language, shows its evidence, and carries a fix the user can apply.
// Shared by the main process (which produces and applies them) and the
// renderer (which shows them); the renderer never sends commands back, only
// finding keys.

export const ANALYZER_VERSION = 1

export type FindingCategory =
  // Can Mission Control create isolated worktrees at all.
  | "git-isolation"
  // The compiler/runtime/SDK a project pins, present at that version.
  | "toolchain"
  // Do dependencies work in the selected workspace itself.
  | "main-environment"
  // What a fresh worktree lacks and how to provide it.
  | "worktree-environment"
  // Outputs regenerated after a merge instead of merged by hand.
  | "generated-files"
  // Ignored config a worktree needs (.env.local, local.properties, …).
  | "local-config"
  // Migrations, schema dumps, shared local databases.
  | "database"
  // Heavy per-worktree builds and cache advice.
  | "build-cost"
  // Dirty tree, unborn HEAD, unsupported layout.
  | "project-state"
  // How seats start the app to test it (plan 109.03).
  | "app-launch"

export const CATEGORY_LABELS: Record<FindingCategory, string> = {
  "git-isolation": "Isolated work",
  toolchain: "Toolchains",
  "main-environment": "Project environment",
  "worktree-environment": "Worktree environment",
  "generated-files": "Generated files",
  "local-config": "Local configuration",
  database: "Databases",
  "build-cost": "Build cost",
  "project-state": "Project state",
  "app-launch": "Running the app",
}

export type FindingSeverity = "blocker" | "warning" | "info"
export type FindingConfidence = "verified" | "likely" | "guess"
export type FindingSource = "rule" | "recipe" | "probe" | "model"
export type FindingStatus = "open" | "resolved" | "dismissed"

export interface Evidence {
  // Stable within one analysis, so model findings can cite it.
  id: string
  kind: "file" | "git" | "probe" | "manifest" | "history" | "setting" | "doc"
  label: string
  // Workspace-relative, when the evidence is a path.
  path?: string
  // A short excerpt: probe output, a version string. Never file contents
  // beyond a marker line, never secrets.
  detail?: string
}

export interface GeneratedFilesRuleShape {
  paths: string[]
  command: string
}

export interface SetupStepShape {
  id: string
  label: string
  command: string
  cwd: string
  // See WorktreeSetupStep: a built-in step and its commands.
  kind?: "command" | "python-shared-venv"
  venv?: string
  fallback?: Array<{ label: string; command: string }>
  refresh?: Array<{ label: string; command: string }>
}

// A proposed app launch service (plan 109.03): who wrote it is set on Apply.
export type AppServiceShape = Omit<AppService, "source" | "findingKey">

// A change to the settings findings target: the workspace's worktree setup,
// generated-file rules, and app launch recipe, and the Feature's overlap
// policy.
export interface WorkspaceSettingsPatch {
  worktreeLinkPaths?: { add?: string[]; remove?: string[] }
  worktreeSetupSteps?: { add?: SetupStepShape[]; remove?: string[] }
  generatedFiles?: { add?: GeneratedFilesRuleShape[] }
  appLaunch?: { add?: AppServiceShape[] }
  overlapPolicy?: "parallel" | "wait"
}

export type ProbeClass = "passive" | "executes-project-code"

export interface ProbeSpec {
  id: string
  label: string
  // Workspace-relative directory.
  cwd: string
  class: ProbeClass
  // A command probe; absent for a filesystem check the analyzer evaluates.
  command?: string
}

export interface CommandSpec {
  label: string
  command: string
  // Workspace-relative directory.
  cwd: string
}

export type Fix =
  | { kind: "apply-settings"; summary: string; patch: WorkspaceSettingsPatch }
  | {
      kind: "run-command"
      summary: string
      commands: CommandSpec[]
      // Applied with the commands ("Apply and run").
      patch?: WorkspaceSettingsPatch
      // Re-run after the commands; the finding resolves only when they pass.
      verify: ProbeSpec[]
    }
  | {
      kind: "run-checks"
      summary: string
      // Probes that execute project code (build scripts), run on approval.
      probes: ProbeSpec[]
    }
  | { kind: "manual"; summary: string; steps: string[]; link?: string }

export interface Finding {
  // Stable across re-analysis, e.g. "worktree-env:.venv".
  key: string
  category: FindingCategory
  severity: FindingSeverity
  title: string
  explanation: string
  evidence: Evidence[]
  confidence: FindingConfidence
  source: FindingSource
  fix: Fix
  alternatives: Fix[]
  status: FindingStatus
  // Why it's resolved ("Already configured", "Probe passed").
  resolution?: string
  // The fix would replace settings the user wrote; never auto-applied.
  replacesUserSetting?: boolean
  // The project root it concerns (workspace-relative), when one.
  root?: string
  // The last attempt to fix it failed: what happened.
  lastRun?: {
    at: number
    ok: boolean
    exitCode: number | null
    note: string
    outputTail: string
  }
}

export interface DetectedProject {
  // Workspace-relative; "" is the workspace root.
  root: string
  ecosystems: Array<{ id: string; language: string; manager: string }>
}

export type AnalysisStatus = "running" | "ready" | "failed"
export type ModelStatus =
  | "pending"
  | "running"
  | "used"
  | "unavailable"
  | "failed"
  | "skipped"

export interface WorkspaceAnalysis {
  featureId: string
  workspaceId: string
  workspacePath: string
  repoRoot: string | null
  // The workspace's place in the repository ("" at the root).
  subpath: string
  status: AnalysisStatus
  // What's running now, for the progress line.
  stage: string | null
  startedAt: number
  analyzedAt: number | null
  fingerprint: string | null
  analyzerVersion: number
  recipeVersion: number
  projects: DetectedProject[]
  findings: Finding[]
  modelStatus: ModelStatus
  modelNote: string | null
  // Model findings validation rejected, and why (diagnostics).
  rejected: Array<{ title: string; reason: string }>
  error: string | null
  // True when the workspace changed since this result (fingerprint drift).
  stale: boolean
}

// A setup run in progress or finished (Apply and run, Apply all, Run checks).
export interface SetupRunView {
  id: string
  featureId: string
  status: "running" | "succeeded" | "failed" | "cancelled"
  startedAt: number
  finishedAt: number | null
  steps: Array<{
    label: string
    command: string
    cwd: string
    kind: "fix" | "probe"
    findingKey: string | null
    status: "pending" | "running" | "ok" | "failed" | "skipped"
    exitCode: number | null
    // The integrated terminal session running it.
    sessionId: string | null
  }>
  note: string | null
}

// What Apply all proposes: every open fix in order, for the review sheet.
export interface ApplyAllItem {
  id: string
  findingKey: string
  title: string
  kind: "settings" | "command" | "check"
  summary: string
  commands: CommandSpec[]
  // Guesses and replacements of user-authored settings start unchecked.
  defaultSelected: boolean
  confidence: FindingConfidence
}

export type Readiness =
  | "not-checked"
  | "checking"
  | "ready"
  | "recommendations"
  | "needs-input"
  | "failed"

export function openFindings(analysis: WorkspaceAnalysis | null): Finding[] {
  return (analysis?.findings ?? []).filter((f) => f.status === "open")
}

export function readinessOf(analysis: WorkspaceAnalysis | null): Readiness {
  if (!analysis) return "not-checked"
  if (analysis.status === "running") return "checking"
  if (analysis.status === "failed") return "failed"
  const open = openFindings(analysis)
  if (open.some((f) => f.severity === "blocker")) return "needs-input"
  if (open.some((f) => f.severity === "warning")) return "recommendations"
  return "ready"
}

export const SEVERITY_ORDER: Record<FindingSeverity, number> = {
  blocker: 0,
  warning: 1,
  info: 2,
}

export const CATEGORY_ORDER: FindingCategory[] = [
  "git-isolation",
  "project-state",
  "toolchain",
  "main-environment",
  "worktree-environment",
  "local-config",
  "generated-files",
  "database",
  "build-cost",
  "app-launch",
]

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) ||
      (a.root ?? "").localeCompare(b.root ?? "") ||
      a.title.localeCompare(b.title)
  )
}
