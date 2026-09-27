import { getRunByWorkspace } from "../db/repositories/index-runs"
import { getIndexing } from "../settings/service"
import type { IndexPriority } from "../db/types"

// Start indexing a workspace that's about to be worked in (plan 008), unless
// the user turned auto-indexing off globally or disabled it for this
// workspace. ensureRunning is idempotent, so callers may fire it freely.
// Failures are logged and never block the caller.
export function autoIndexWorkspace(
  workspaceId: string,
  priority: IndexPriority,
  service: {
    ensureRunning(workspaceId: string, priority: IndexPriority): void
  },
  watcher?: { start: (workspaceId: string) => Promise<void> }
): void {
  if (!getIndexing().autoIndexNewWorkspaces) return
  const run = getRunByWorkspace(workspaceId)
  if (run && !run.enabled) return
  try {
    service.ensureRunning(workspaceId, priority)
    void watcher?.start(workspaceId)
  } catch (err) {
    console.error("auto-index trigger failed:", err)
  }
}
