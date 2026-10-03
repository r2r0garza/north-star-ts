// Where QA seats keep acceptance checks (plan 109.01). Shared so the main
// process and the Feature home setup editor agree on the default and on what
// a valid directory is.

// A visible, conventional test folder, not a hidden tool folder: checks are
// committed with the code, and the user should find and re-run them like any
// other tests.
export const DEFAULT_CHECKS_DIR = "e2e"

// The run's scratch area. Its own .gitignore (written when a QA phase starts)
// keeps it out of the user story's commit.
export const SCRATCH_DIR = ".mission-control/scratch"

// A checks directory as stored: workspace-relative, "/"-separated, no leading
// "./" or trailing slash. Null when it can't be one — empty (the whole
// workspace isn't a checks directory), leaving the workspace, or inside .git.
export function normalizeChecksDir(value: unknown): string | null {
  if (typeof value !== "string") return null
  const parts = value
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part !== "" && part !== ".")
  if (!parts.length || value.trim().startsWith("/")) return null
  if (parts.includes("..") || parts[0] === ".git") return null
  return parts.join("/")
}

// A user story's stable reference in the checks: the tag on each of its tests
// (`@<ref>`, so `--grep @<ref>` re-runs them) and the name of its manifest.
// Checks themselves are shared test code organized by product area, so the
// story is traced by tag, not by folder. Feature and milestone keys are part
// of it because user story keys are unique only within a milestone. Resolved
// server-side from the plan, never from the model.
export function userStoryRef(keys: {
  featureKey: string
  milestoneKey: string
  userStoryKey: string
}): string {
  const segment = (key: string) => key.replace(/[^A-Za-z0-9_-]+/g, "-") || "-"
  return [keys.featureKey, keys.milestoneKey, keys.userStoryKey]
    .map(segment)
    .join(".")
}

// Where a user story's check manifest lives (plan 109.02), relative to the
// checks directory: `<checksDir>/stories/<storyRef>.json`. The harness finds
// it from the story ref; the model never names the path.
export const MANIFEST_DIR = "stories"

export function storyManifestPath(checksDir: string, storyRef: string): string {
  return `${checksDir}/${MANIFEST_DIR}/${storyRef}.json`
}
