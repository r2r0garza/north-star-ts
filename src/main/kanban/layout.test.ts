import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  detectedLinks,
  linkCommands,
  linkRepo,
  workspaceLayout,
} from "./layout"

const dir = () => mkdtempSync(path.join(tmpdir(), "kanban-layout-"))
const repo = (...parts: string[]) =>
  mkdirSync(path.join(...parts, ".git"), { recursive: true })

describe("workspaceLayout", () => {
  it("is a repo when the workspace is in one, even a subfolder", () => {
    const root = dir()
    repo(root)
    mkdirSync(path.join(root, "app"))
    expect(workspaceLayout(path.join(root, "app"))).toEqual({
      layout: "repo",
      repos: [],
    })
  })

  it("lists repos up to two levels down, skipping dependency, build and hidden folders", () => {
    const root = dir()
    repo(root, "backend")
    repo(root, "apps", "web")
    repo(root, "a", "b", "too-deep")
    repo(root, "node_modules", "pkg")
    repo(root, ".cache-repos", "x")
    repo(root, "backend", "nested") // inside a found repo: not searched
    expect(workspaceLayout(root)).toEqual({
      layout: "repos",
      repos: ["apps/web", "backend"],
    })
  })

  it("is none without repos or a workspace", () => {
    expect(workspaceLayout(dir()).layout).toBe("none")
    expect(workspaceLayout(null).layout).toBe("none")
  })
})

describe("dependency links", () => {
  it("detects dependency folders at the top of each repo, and at a layout-A subfolder", () => {
    const b = dir()
    repo(b, "backend")
    repo(b, "apps", "web")
    mkdirSync(path.join(b, "backend", "node_modules"))
    mkdirSync(path.join(b, "apps", "web", ".venv"))
    mkdirSync(path.join(b, "apps", "web", "pkg", "node_modules"), {
      recursive: true,
    }) // nested: left to the board settings
    expect(detectedLinks(b)).toEqual(["apps/web/.venv", "backend/node_modules"])

    const a = dir()
    repo(a)
    mkdirSync(path.join(a, "node_modules"))
    mkdirSync(path.join(a, "app", "node_modules"), { recursive: true })
    expect(detectedLinks(path.join(a, "app"))).toEqual([
      "app/node_modules",
      "node_modules",
    ])
    expect(detectedLinks(dir())).toEqual([])
  })

  it("assigns a link to the longest repo it starts with", () => {
    expect(linkRepo("apps/web/node_modules", ["apps", "apps/web"])).toBe(
      "apps/web"
    )
    expect(linkRepo("other/node_modules", ["apps"])).toBeUndefined()
  })

  it("links only paths the real checkout has, quoted", () => {
    const real = path.join(dir(), "it's")
    mkdirSync(path.join(real, "apps", "web", "node_modules"), {
      recursive: true,
    })
    const q = real.replace("'", "'\\''")
    expect(
      linkCommands(["apps/web/node_modules", "missing"], real, "/wt")
    ).toEqual([
      `[ -e '/wt/apps/web/node_modules' ] || ln -s '${q}/apps/web/node_modules' '/wt/apps/web/node_modules'`,
    ])
  })
})
