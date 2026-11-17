import { existsSync, readdirSync } from "node:fs"
import path from "node:path"
import { DEFAULT_SKIP_DIRS } from "../agent/env/walk"
import type { KanbanLayout } from "../../shared/kanban"

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
