import { execFile } from "child_process"
import { promisify } from "util"
import { truncateUtf8Text } from "../agent/tools/output"

// On-demand git diff for a single workspace-relative file, used by the
// changed-file pills / sidebar "Changes" review in the renderer. No diff library
// and no before/after capture: we shell out to the user's git, which is already
// present in any real dev workspace. This returns the WORKING-TREE diff for the
// file (its difference from HEAD), not "what one turn changed" — an accepted
// trade-off for zero capture cost (see the plan's open considerations).

const run = promisify(execFile)

// Bound git so a pathological repo can't wedge the UI, and cap the payload so a
// huge diff can't blow up the popover / IPC.
const GIT_TIMEOUT_MS = 5_000
const MAX_DIFF_BYTES = 512 * 1024

export interface GitDiffResult {
  // Unified diff text (may be truncated — see `truncated`).
  diff: string
  // Whether the file is untracked (brand new): the diff is synthesized as
  // all-additions via `git diff --no-index`.
  untracked: boolean
  truncated: boolean
}

// Whether `cwd` is inside a git work tree. Cheap gate so callers can fall back to
// showing plain file content when there's no repo.
async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await run(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      { cwd, timeout: GIT_TIMEOUT_MS }
    )
    return stdout.trim() === "true"
  } catch {
    return false
  }
}

function clip(text: string): { text: string; truncated: boolean } {
  return truncateUtf8Text(text, MAX_DIFF_BYTES)
}

// Diff one workspace-relative file. Returns null when `workspace` isn't a git
// repo (caller falls back to showing current content). For a tracked file with
// no changes, `diff` is an empty string. For an untracked (new) file, synthesizes
// an all-additions diff so a freshly created file still previews.
//
// `relPath` MUST already be validated as inside the workspace by the caller.
export async function gitDiffFile(
  workspace: string,
  relPath: string
): Promise<GitDiffResult | null> {
  if (!(await isGitRepo(workspace))) return null

  // Is the file tracked by git? `ls-files` prints the path when tracked, nothing
  // when untracked. This decides which diff strategy applies — critically, it
  // stops a tracked-but-unchanged file from being misread as brand new by the
  // --no-index probe below.
  let tracked = false
  try {
    const { stdout } = await run("git", ["ls-files", "--", relPath], {
      cwd: workspace,
      timeout: GIT_TIMEOUT_MS,
    })
    tracked = stdout.trim().length > 0
  } catch {
    // Treat an ls-files failure as "not tracked"; the probes below still cope.
  }

  if (tracked) {
    // Tracked: the working-tree diff vs HEAD. Empty when unchanged. `--` separates
    // paths from revisions so a filename that looks like a flag/ref isn't misread.
    try {
      const { stdout } = await run("git", ["diff", "--", relPath], {
        cwd: workspace,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_DIFF_BYTES * 4,
      })
      const { text, truncated } = clip(stdout)
      return { diff: text, untracked: false, truncated }
    } catch {
      return { diff: "", untracked: false, truncated: false }
    }
  }

  // Untracked (newly created): `--no-index` against /dev/null yields an
  // all-additions diff. It exits non-zero (1) WHEN there's a difference, so a
  // thrown error here still carries stdout.
  try {
    const { stdout } = await run(
      "git",
      ["diff", "--no-index", "--", "/dev/null", relPath],
      { cwd: workspace, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_DIFF_BYTES * 4 }
    )
    const { text, truncated } = clip(stdout)
    return { diff: text, untracked: true, truncated }
  } catch (err) {
    const stdout = (err as { stdout?: string }).stdout ?? ""
    const { text, truncated } = clip(stdout)
    return { diff: text, untracked: true, truncated }
  }
}
