import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { execFileSync } from "child_process"
import { existsSync, readFileSync, writeFileSync } from "fs"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import type { MissionControlRunLink } from "../db/types"

const checksDir = { value: "e2e" }
vi.mock("../db/repositories/features", () => ({
  getFeature: (id: string) =>
    id === "f1" ? { id, key: "billing", workspaceId: "w1" } : null,
  getUserStory: (id: string) =>
    id === "s1" ? { id, key: "login", milestoneId: "m1" } : null,
  getMilestone: (id: string) => (id === "m1" ? { id, key: "mvp" } : null),
}))
vi.mock("../db/repositories/workspaces", () => ({
  getWorkspace: () => ({ missionControl: { checksDir: checksDir.value } }),
}))

import { seatWriteScope, writeScopeContextSection } from "./qa-scope"

const storyRun: MissionControlRunLink = {
  featureId: "f1",
  milestoneId: "m1",
  userStoryId: "s1",
  playbookRunId: "p1",
  hook: "user_story" as MissionControlRunLink["hook"],
}

let worktree: string
beforeEach(async () => {
  worktree = await mkdtemp(join(tmpdir(), "qa-scope-"))
  checksDir.value = "e2e"
})
afterEach(async () => {
  await rm(worktree, { recursive: true, force: true })
})

describe("seatWriteScope", () => {
  it("leaves non-qa roles unrestricted", async () => {
    expect(
      await seatWriteScope({
        role: "builder",
        link: storyRun,
        runId: "r1",
        workingDirectory: worktree,
      })
    ).toBeUndefined()
  })

  it("confines a qa seat to the checks directory and the run's scratch directory", async () => {
    const scope = await seatWriteScope({
      role: "qa",
      link: storyRun,
      runId: "r1",
      workingDirectory: worktree,
    })
    // The whole checks directory: checks are shared test code, not a folder
    // per user story.
    expect(scope!.writeScope).toEqual({
      allow: ["e2e", ".mission-control/scratch/r1"],
    })
    expect(existsSync(join(worktree, "e2e"))).toBe(true)
    // The scratch directory ignores itself, so it is never committed.
    expect(
      readFileSync(
        join(worktree, ".mission-control/scratch/r1/.gitignore"),
        "utf8"
      )
    ).toBe("*\n")
  })

  it("uses the workspace's checks directory setting", async () => {
    checksDir.value = "tests/acceptance"
    const scope = await seatWriteScope({
      role: "qa",
      link: storyRun,
      runId: "r1",
      workingDirectory: worktree,
    })
    expect(scope!.writeScope.allow[0]).toBe("tests/acceptance")
  })

  it("refuses a checks directory git ignores, so checks are never silently lost", async () => {
    execFileSync("git", ["init", "-q"], { cwd: worktree })
    writeFileSync(join(worktree, ".gitignore"), "e2e/\n")
    await expect(
      seatWriteScope({
        role: "qa",
        link: storyRun,
        runId: "r1",
        workingDirectory: worktree,
      })
    ).rejects.toThrow(/"e2e" is ignored by git/)
  })

  it("accepts a tracked checks directory in a repository, and ignores the scratch directory", async () => {
    execFileSync("git", ["init", "-q"], { cwd: worktree })
    await seatWriteScope({
      role: "qa",
      link: storyRun,
      runId: "r1",
      workingDirectory: worktree,
    })
    writeFileSync(join(worktree, "e2e/a.spec.ts"), "x")
    writeFileSync(join(worktree, ".mission-control/scratch/r1/out.log"), "x")
    const status = execFileSync(
      "git",
      ["status", "--porcelain", "--untracked-files=all"],
      { cwd: worktree, encoding: "utf8" }
    )
    expect(status).toContain("e2e/a.spec.ts")
    expect(status).not.toContain(".mission-control")
  })

  it("gives a qa seat on a milestone run the same directories, with no story tag", async () => {
    const scope = await seatWriteScope({
      role: "qa",
      link: { ...storyRun, userStoryId: null },
      runId: "r2",
      workingDirectory: worktree,
    })
    expect(scope!.writeScope).toEqual({
      allow: ["e2e", ".mission-control/scratch/r2"],
    })
    expect(scope!.contextSection.content).not.toMatch(/Tag every check/)
  })

  it("tells the seat where it may write, how to organize checks, and its story tag", async () => {
    const scope = await seatWriteScope({
      role: "qa",
      link: storyRun,
      runId: "r1",
      workingDirectory: worktree,
    })
    const content = scope!.contextSection.content
    expect(content).toContain("`e2e/`")
    expect(content).toContain("`.mission-control/scratch/r1/`")
    expect(content).toMatch(/read-only to you/)
    expect(content).toContain("`e2e/pages/`")
    expect(content).toMatch(/Reuse existing page objects/)
    expect(content).toContain("`@billing.mvp.login`")
  })
})
