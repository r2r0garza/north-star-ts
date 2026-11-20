import { existsSync, readdirSync } from "node:fs"
import path from "node:path"
import { DEFAULT_SKIP_DIRS } from "../agent/env/walk"
import { shellQuote, type KanbanLayout } from "../../shared/kanban"

const SKIP = new Set(DEFAULT_SKIP_DIRS)
// How deep a folder of repos is searched: repo-1/ and group/repo-1/.
const MAX_DEPTH = 2

const isRepo = (dir: string) => existsSync(path.join(dir, ".git"))

// How a board's workspace holds code (plan 136.6). `repo`: the workspace is a
// git repo or inside one. `repos`: a plain folder holding repos, listed relative
// to it ("/"-separated). `none`: no repos. Repos inside a found repo aren't
// searched (nested repos are a later slice).
export function workspaceLayout(workspace: string | null): {
  layout: KanbanLayout
  repos: string[]
} {
  if (!workspace || !existsSync(workspace)) return { layout: "none", repos: [] }
  for (let dir = workspace; ; dir = path.dirname(dir)) {
    if (isRepo(dir)) return { layout: "repo", repos: [] }
    if (path.dirname(dir) === dir) break
  }
  const repos: string[] = []
  const walk = (dir: string, rel: string, depth: number) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP.has(e.name) || e.name.startsWith("."))
        continue
      const child = path.join(dir, e.name)
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (isRepo(child)) repos.push(childRel)
      else if (depth < MAX_DEPTH) walk(child, childRel, depth + 1)
    }
  }
  walk(workspace, "", 1)
  repos.sort()
  return { layout: repos.length ? "repos" : "none", repos }
}

// Installed dependencies git leaves out of a worktree (plan 136.6). A board's
// dependency links are paths to them, relative to the repo in layout A and to
// the workspace in layout B (so they start with a repo). The agent gets one
// link command per path that exists in the real checkout.
const DEPENDENCY_DIRS = ["node_modules", ".venv"]

// The repo a layout-A workspace is in (the workspace or a parent).
export function repoTop(workspace: string): string | null {
  for (let dir = workspace; ; dir = path.dirname(dir)) {
    if (isRepo(dir)) return dir
    if (path.dirname(dir) === dir) return null
  }
}

// The default links: dependency folders at the top of each repo (layout A:
// also at the workspace's subfolder). Nested packages (apps/web/node_modules)
// aren't scanned; the board settings add them.
export function detectedLinks(workspace: string | null): string[] {
  const { layout, repos } = workspaceLayout(workspace)
  if (!workspace || layout === "none") return []
  const top = layout === "repo" ? repoTop(workspace)! : workspace
  const roots =
    layout === "repo"
      ? ["", path.relative(top, workspace).split(path.sep).join("/")]
      : repos
  const found = roots.flatMap((r) =>
    DEPENDENCY_DIRS.map((d) => (r ? `${r}/${d}` : d))
  )
  return [...new Set(found)].filter((p) => existsSync(path.join(top, p))).sort()
}

// The layout-B repo a link belongs to: the longest repo path it starts with.
export function linkRepo(link: string, repos: string[]): string | undefined {
  return repos
    .filter((r) => link.startsWith(`${r}/`))
    .sort((a, b) => b.length - a.length)[0]
}

// Link commands for the links that exist under `real`, into `worktree`.
// Idempotent, and a folder the worktree already has is left alone.
export function linkCommands(
  links: string[],
  real: string,
  worktree: string
): string[] {
  return links
    .filter((l) => existsSync(path.join(real, l)))
    .map((l) => {
      const to = shellQuote(path.join(worktree, l))
      return `[ -e ${to} ] || ln -s ${shellQuote(path.join(real, l))} ${to}`
    })
}

export const DEPENDENCY_LINK_NOTE =
  "The links share the real checkout's installed packages: never install, update or remove packages through them (that changes the real checkout), and a Python .venv's editable install still imports the real checkout's code."
