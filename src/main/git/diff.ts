import { GitService } from "./service"

// On-demand git diff for a single workspace-relative file, used by the
// changed-file pills / sidebar "Changes" review in the renderer. No diff library
// and no before/after capture: we shell out to the user's git, which is already
// present in any real dev workspace. This returns the WORKING-TREE diff for the
// file (its difference from HEAD), not "what one turn changed" — an accepted
// trade-off for zero capture cost (see the plan's open considerations).

export interface GitDiffResult {
  // Unified diff text (may be truncated — see `truncated`).
  diff: string
  // Whether the file is untracked (brand new): the diff is synthesized as
  // all-additions via `git diff --no-index`.
  untracked: boolean
  truncated: boolean
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
  return new GitService(workspace).diffFile(relPath)
}
