import { execFile } from "child_process"
import { dirname } from "path"
import { promisify } from "util"
import { getWorkspaceByPath } from "../db/repositories/workspaces"
import { getRunByWorkspace } from "../db/repositories/index-runs"
import type { IndexRun, Workspace } from "../db/types"

const execFileAsync = promisify(execFile)

export interface IndexedWorkspace {
  workspace: Workspace
  run: IndexRun
  // The index belongs to the repository's main checkout, not the directory
  // asked about (a git worktree of it). Index paths are repo-relative, so they
  // hold in the worktree, but the worktree's own edits aren't reflected.
  viaMainCheckout: boolean
}

// Worktree path → its main checkout. Stable for a worktree's life, so cached.
const mainCheckouts = new Map<string, string | null>()

// The main checkout of the git repository `path` is a linked worktree of, or
// null when it isn't one (or git can't say).
async function mainCheckoutOf(path: string): Promise<string | null> {
  if (mainCheckouts.has(path)) return mainCheckouts.get(path)!
  let root: string | null = null
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: path, timeout: 5000 }
    )
    const commonDir = stdout.trim()
    // A non-bare repository's common dir is <main checkout>/.git.
    if (commonDir.endsWith("/.git")) {
      const candidate = dirname(commonDir)
      if (candidate !== path) root = candidate
    }
  } catch {
    root = null
  }
  mainCheckouts.set(path, root)
  return root
}

function indexed(workspace: Workspace | undefined): IndexRun | null {
  if (!workspace) return null
  const run = getRunByWorkspace(workspace.id)
  return run && run.filesScanned > 0 ? run : null
}

// The indexed workspace to answer index queries for `path`. A Mission Control
// user story runs in its own git worktree, which is registered as a workspace
// of its own but never indexed; its repository's main checkout is. Fall back
// to that checkout's index when `path` has none.
export async function indexedWorkspaceFor(
  path: string
): Promise<IndexedWorkspace | null> {
  const own = getWorkspaceByPath(path)
  const ownRun = indexed(own)
  if (own && ownRun)
    return { workspace: own, run: ownRun, viaMainCheckout: false }
  const root = await mainCheckoutOf(path)
  if (!root) return null
  const main = getWorkspaceByPath(root)
  const mainRun = indexed(main)
  return main && mainRun
    ? { workspace: main, run: mainRun, viaMainCheckout: true }
    : null
}
