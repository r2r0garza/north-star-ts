import { execFileSync } from "child_process"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { afterEach, describe, expect, it } from "vitest"
import {
  repositoryDelegationLeases,
  repositoryIdentity,
} from "./repository-lease"

const dirs: string[] = []
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

function repo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "subagent-lease-"))
  dirs.push(root)
  git(root, "init")
  git(root, "config", "user.email", "test@example.com")
  git(root, "config", "user.name", "Test")
  return root
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("RepositoryDelegationLeaseService", () => {
  it("blocks another owner for the same repository", async () => {
    const root = repo()
    const lease = await repositoryDelegationLeases.acquire(root, "writers")
    expect(await repositoryDelegationLeases.blocker(root)).toMatchObject({
      label: "writers",
    })
    expect(
      await repositoryDelegationLeases.blocker(root, lease.token)
    ).toBeUndefined()
    repositoryDelegationLeases.release(lease)
    expect(await repositoryDelegationLeases.blocker(root)).toBeUndefined()
  })

  it("pauses only the active deadline and keeps the absolute deadline fixed", async () => {
    const root = repo()
    const lease = await repositoryDelegationLeases.acquire(root, "writers")
    const activeDeadline = lease.activeDeadlineAt
    const absoluteDeadline = lease.absoluteDeadlineAt
    repositoryDelegationLeases.pause(lease, lease.acquiredAt + 1_000)
    expect(repositoryDelegationLeases.timeoutKind(lease, activeDeadline + 1)).toBeUndefined()
    repositoryDelegationLeases.resume(lease, lease.acquiredAt + 6_000)
    expect(lease.activeDeadlineAt).toBe(activeDeadline + 5_000)
    expect(lease.absoluteDeadlineAt).toBe(absoluteDeadline)
    expect(repositoryDelegationLeases.timeoutKind(lease, lease.activeDeadlineAt)).toBe(
      "active"
    )
    repositoryDelegationLeases.release(lease)
  })

  it("uses the common directory for linked worktrees", async () => {
    const root = repo()
    expect(await repositoryIdentity(root)).toContain(".git")
  })
})
