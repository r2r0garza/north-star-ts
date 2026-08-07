import { readFile } from "fs/promises"
import { execFile } from "child_process"
import { join } from "path"
import { promisify } from "util"
import { load as parseYaml } from "js-yaml"

const execFileAsync = promisify(execFile)

// Stage 2 parses a small, high-value set of workspace docs into index_metadata.
// Each descriptor names the file(s) to look for and how to turn one into a JSON
// value. `kind` is the index_metadata.kind key (one row per kind).
export interface MetadataDoc {
  kind: string
  // Candidate relative paths, tried in order; first that exists wins.
  candidates: string[]
  parse: (raw: string) => unknown
}

const asJson = (raw: string): unknown => JSON.parse(raw)
// README is stored as a short excerpt, not the whole file.
const asReadmeExcerpt = (raw: string): unknown => ({
  excerpt: raw.slice(0, 2000),
  bytes: raw.length,
})

export const METADATA_FILES: MetadataDoc[] = [
  { kind: "package_json", candidates: ["package.json"], parse: asJson },
  {
    kind: "tsconfig",
    candidates: ["tsconfig.json", "tsconfig.base.json"],
    parse: asJson,
  },
  {
    kind: "pnpm_workspace",
    candidates: ["pnpm-workspace.yaml"],
    parse: (raw) => parseYaml(raw) ?? {},
  },
  {
    kind: "readme",
    candidates: ["README.md", "README.MD", "readme.md", "README"],
    parse: asReadmeExcerpt,
  },
]

// vite config comes in several extensions; handled specially (presence + name).
const VITE_CANDIDATES = [
  "vite.config.ts",
  "vite.config.js",
  "vite.config.mjs",
  "electron.vite.config.ts",
]

export interface ParsedMetadata {
  path: string
  value: unknown
}

// Parse one metadata doc from the workspace root. Returns null if no candidate
// exists or parsing fails (a malformed config shouldn't fail the whole stage).
export async function parseMetadataDoc(
  root: string,
  doc: MetadataDoc
): Promise<ParsedMetadata | null> {
  for (const rel of doc.candidates) {
    try {
      const raw = await readFile(join(root, rel), "utf8")
      return { path: rel, value: doc.parse(raw) }
    } catch {
      // Missing or unparseable — try the next candidate.
    }
  }
  return null
}

// Detect the vite/electron-vite config by presence (contents aren't parsed —
// they're JS, not data). Records which config file exists as a framework hint.
export async function detectViteConfig(
  root: string
): Promise<ParsedMetadata | null> {
  for (const rel of VITE_CANDIDATES) {
    try {
      await readFile(join(root, rel), "utf8")
      return { path: rel, value: { present: true, config: rel } }
    } catch {
      // try next
    }
  }
  return null
}

// Read the current git branch for `root`. Prefers `git` itself so we get the
// RIGHT answer for the cases a naive `.git/HEAD` read gets wrong:
//   - worktrees / submodules, where `.git` is a FILE ("gitdir: …"), not a dir,
//   - a workspace path that's a SUBDIRECTORY of the repo (HEAD lives at the top),
//   - packed refs.
// `symbolic-ref` yields the branch on an attached HEAD; a detached HEAD fails it,
// so we fall back to a short SHA via `rev-parse`. Only when git can't run at all
// (not on PATH) do we fall back to the zero-dependency `.git/HEAD` file read,
// which still covers the common top-level-repo case. Returns null when `root`
// isn't inside a git work tree.
const GIT_BRANCH_TIMEOUT_MS = 3000

export async function readGitBranch(
  root: string
): Promise<ParsedMetadata | null> {
  const git = (args: string[]) =>
    execFileAsync("git", args, { cwd: root, timeout: GIT_BRANCH_TIMEOUT_MS })

  try {
    // Attached HEAD → full ref like "refs/heads/feat/x". `--quiet` makes a
    // detached HEAD exit non-zero (into catch) instead of printing to stderr.
    const { stdout } = await git(["symbolic-ref", "--quiet", "HEAD"])
    const ref = stdout.trim()
    const branch = ref.replace(/^refs\/heads\//, "")
    return { path: "git", value: { branch, ref } }
  } catch (err) {
    // A non-zero exit from symbolic-ref means either a detached HEAD (git ran
    // fine) or git isn't available (ENOENT). Distinguish: try rev-parse for the
    // detached case; if THAT also can't run, git is missing → file fallback.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return readGitBranchFromFile(root)
    }
    try {
      const { stdout } = await git(["rev-parse", "--short=12", "HEAD"])
      const sha = stdout.trim()
      if (sha) return { path: "git", value: { detached: true, sha } }
    } catch {
      // Not a repo, or git unavailable — fall through to the file probe.
    }
    return readGitBranchFromFile(root)
  }
}

// Zero-dependency fallback: read the branch straight from `<root>/.git/HEAD`.
// Only correct when `root` is the repo top level and `.git` is a real directory
// (not a worktree pointer file), which is why it's the fallback, not the primary.
async function readGitBranchFromFile(
  root: string
): Promise<ParsedMetadata | null> {
  try {
    const head = (await readFile(join(root, ".git", "HEAD"), "utf8")).trim()
    if (head.startsWith("ref:")) {
      const ref = head.slice(4).trim()
      const branch = ref.replace(/^refs\/heads\//, "")
      return { path: ".git/HEAD", value: { branch, ref } }
    }
    return {
      path: ".git/HEAD",
      value: { detached: true, sha: head.slice(0, 12) },
    }
  } catch {
    return null
  }
}
