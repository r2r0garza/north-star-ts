import { execFile } from "child_process"
import { promisify } from "util"
import path from "path"
import { randomUUID } from "crypto"

const execFileAsync = promisify(execFile)

export const REPOSITORY_LEASE_ACTIVE_TIMEOUT_MS = 30 * 60_000
export const REPOSITORY_LEASE_ABSOLUTE_TIMEOUT_MS = 90 * 60_000

export interface RepositoryLease {
  repositoryId: string
  sessionId: string
  label: string
  token: string
  acquiredAt: number
  activeDeadlineAt: number
  absoluteDeadlineAt: number
  pausedAt?: number
}

export async function repositoryIdentity(workspace: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: workspace, encoding: "utf8", timeout: 5000 }
  )
  return path.resolve(stdout.trim())
}

class RepositoryDelegationLeaseService {
  private readonly leases = new Map<string, RepositoryLease>()

  async acquire(workspace: string, label: string): Promise<RepositoryLease> {
    const repositoryId = await repositoryIdentity(workspace)
    const current = this.leases.get(repositoryId)
    if (current) throw new Error(`repository_busy:${current.label}`)
    const acquiredAt = Date.now()
    const lease: RepositoryLease = {
      repositoryId,
      sessionId: randomUUID(),
      label,
      token: randomUUID(),
      acquiredAt,
      activeDeadlineAt: acquiredAt + REPOSITORY_LEASE_ACTIVE_TIMEOUT_MS,
      absoluteDeadlineAt: acquiredAt + REPOSITORY_LEASE_ABSOLUTE_TIMEOUT_MS,
    }
    this.leases.set(repositoryId, lease)
    return lease
  }

  release(lease: RepositoryLease): void {
    if (this.leases.get(lease.repositoryId)?.token === lease.token) {
      this.leases.delete(lease.repositoryId)
    }
  }

  pause(lease: RepositoryLease, now = Date.now()): void {
    const current = this.leases.get(lease.repositoryId)
    if (current?.token === lease.token && current.pausedAt === undefined) {
      current.pausedAt = now
    }
  }

  resume(lease: RepositoryLease, now = Date.now()): void {
    const current = this.leases.get(lease.repositoryId)
    if (current?.token !== lease.token || current.pausedAt === undefined) return
    current.activeDeadlineAt += Math.max(0, now - current.pausedAt)
    current.pausedAt = undefined
  }

  timeoutKind(
    lease: RepositoryLease,
    now = Date.now()
  ): "active" | "absolute" | undefined {
    const current = this.leases.get(lease.repositoryId)
    if (current?.token !== lease.token) return "absolute"
    if (now >= current.absoluteDeadlineAt) return "absolute"
    if (current.pausedAt === undefined && now >= current.activeDeadlineAt) return "active"
    return undefined
  }

  nextTimeoutMs(lease: RepositoryLease, now = Date.now()): number {
    const current = this.leases.get(lease.repositoryId)
    if (current?.token !== lease.token) return 0
    const deadline =
      current.pausedAt === undefined
        ? Math.min(current.activeDeadlineAt, current.absoluteDeadlineAt)
        : current.absoluteDeadlineAt
    return Math.max(0, deadline - now)
  }

  async blocker(
    workspace: string,
    ownerToken?: string
  ): Promise<RepositoryLease | undefined> {
    try {
      const lease = this.leases.get(await repositoryIdentity(workspace))
      return lease && lease.token !== ownerToken ? lease : undefined
    } catch {
      return undefined
    }
  }

  list(): RepositoryLease[] {
    return [...this.leases.values()]
  }
}

export const repositoryDelegationLeases =
  new RepositoryDelegationLeaseService()
