import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { workspaceLayout } from "./layout"

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
