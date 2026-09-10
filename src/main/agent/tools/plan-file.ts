import { app } from "electron"
import { lstat, mkdir, readdir, unlink } from "fs/promises"
import path from "path"
import { dataDirName } from "../../config/system-name"

export const PLAN_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const PLAN_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface PlanCleanupResult {
  removed: number
  failed: number
}

export interface PlanPruneResult extends PlanCleanupResult {
  inspected: number
}

// The plan document a plan-mode turn writes: ~/.<name>/plans/<conversationId>.md.
// Fixed, server-computed path (never model-supplied), reusing the same
// ~/.<name>/... data-dir convention as userSkillsDir(). Shared by write_plan_tool
// (writes it) and present_plan_tool (reads it back for approval).
export function planFilePath(conversationId: string): string {
  return path.join(
    app.getPath("home"),
    dataDirName(),
    "plans",
    `${conversationId}.md`
  )
}

// Ensure the ~/.<name>/plans directory exists before a write. Mirrors the
// mkdir-recursive pattern used for the skills dir.
export async function ensurePlansDir(conversationId: string): Promise<string> {
  const file = planFilePath(conversationId)
  await mkdir(path.dirname(file), { recursive: true })
  return file
}

export async function deletePlanFile(conversationId: string): Promise<boolean> {
  try {
    await unlink(planFilePath(conversationId))
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false
    throw err
  }
}

export async function deletePlanFiles(
  conversationIds: Iterable<string>
): Promise<PlanCleanupResult> {
  let removed = 0
  let failed = 0
  for (const conversationId of new Set(conversationIds)) {
    try {
      if (await deletePlanFile(conversationId)) removed++
    } catch (err) {
      failed++
      console.warn("[plans] conversation cleanup failed:", {
        conversationId,
        code: (err as NodeJS.ErrnoException).code,
      })
    }
  }
  return { removed, failed }
}

export async function pruneExpiredPlanFiles(
  now = Date.now()
): Promise<PlanPruneResult> {
  const plansDir = path.dirname(planFilePath("placeholder"))
  let entries
  try {
    entries = await readdir(plansDir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { inspected: 0, removed: 0, failed: 0 }
    }
    throw err
  }

  const result: PlanPruneResult = { inspected: 0, removed: 0, failed: 0 }
  const cutoff = now - PLAN_TTL_MS
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name) !== ".md") continue
    result.inspected++
    const file = path.join(plansDir, entry.name)
    try {
      const stat = await lstat(file)
      if (!stat.isFile() || stat.mtimeMs >= cutoff) continue
      await unlink(file)
      result.removed++
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        result.failed++
      }
    }
  }
  return result
}

let maintenanceTimer: ReturnType<typeof setInterval> | undefined
let maintenanceRun: Promise<PlanPruneResult> | undefined

export function runPlanMaintenance(): Promise<PlanPruneResult> {
  if (maintenanceRun) return maintenanceRun
  maintenanceRun = pruneExpiredPlanFiles()
    .then((result) => {
      if (result.failed > 0) {
        console.warn("[plans] maintenance completed with failures:", result)
      }
      return result
    })
    .catch((err) => {
      console.warn("[plans] maintenance failed:", {
        code: (err as NodeJS.ErrnoException).code,
        message: err instanceof Error ? err.message : String(err),
      })
      return { inspected: 0, removed: 0, failed: 1 }
    })
    .finally(() => {
      maintenanceRun = undefined
    })
  return maintenanceRun
}

export function startPlanMaintenance(): Promise<PlanPruneResult> {
  if (!maintenanceTimer) {
    maintenanceTimer = setInterval(() => {
      void runPlanMaintenance()
    }, PLAN_MAINTENANCE_INTERVAL_MS)
    maintenanceTimer.unref()
  }
  return runPlanMaintenance()
}

export function stopPlanMaintenance(): void {
  if (maintenanceTimer) clearInterval(maintenanceTimer)
  maintenanceTimer = undefined
}
