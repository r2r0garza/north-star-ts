import { execFile } from "child_process"
import { readFile, rm } from "fs/promises"
import { promisify } from "util"
import {
  getSubagentArtifact,
  settleSubagentArtifact,
} from "../../db/repositories/subagent-artifacts"

const execFileAsync = promisify(execFile)

export async function reconcileActiveSubagentArtifact(
  artifact: NonNullable<ReturnType<typeof getSubagentArtifact>>
): Promise<void> {
  if (artifact.status !== "active") return
  const detail =
    artifact.detail && typeof artifact.detail === "object"
      ? (artifact.detail as Record<string, unknown>)
      : undefined
  const runtime = detail?.runtime
  const containerName = detail?.containerName
  if (
    artifact.backend === "container" &&
    (runtime === "docker" || runtime === "podman") &&
    typeof containerName === "string"
  ) {
    try {
      await execFileAsync(runtime, ["rm", "-f", containerName], { timeout: 30_000 })
      await resolveQuarantinedArtifact({ id: artifact.id, keepBranch: true })
      return
    } catch (error) {
      settleSubagentArtifact(artifact.id, "quarantined_cleanup_required", {
        reason: "container_crash_cleanup_failed",
        error: error instanceof Error ? error.message : String(error),
        runtime,
        containerName,
      })
      return
    }
  }
  settleSubagentArtifact(artifact.id, "quarantined_cleanup_required", {
    reason: "application_restarted_during_writer_run",
  })
}

export async function resolveQuarantinedArtifact(input: {
  id: string
  keepBranch: boolean
}): Promise<ReturnType<typeof settleSubagentArtifact>> {
  const artifact = getSubagentArtifact(input.id)
  if (!artifact) throw new Error("Subagent artifact not found.")
  if (artifact.status === "resolved") return artifact
  let marker: Record<string, unknown>
  try {
    marker = JSON.parse(await readFile(artifact.markerPath, "utf8"))
  } catch {
    // The owned path is already gone. Resolve the record without touching refs.
    return settleSubagentArtifact(artifact.id, "resolved", {
      resolution: "artifacts_already_absent",
      branch: artifact.branch,
    })
  }
  if (
    marker.sessionId !== artifact.sessionId ||
    marker.repositoryId !== artifact.repositoryId ||
    marker.branch !== artifact.branch
  ) {
    throw new Error("Subagent artifact ownership marker does not match the record.")
  }
  await execFileAsync(
    "git",
    [
      `--git-dir=${artifact.repositoryId}`,
      "worktree",
      "remove",
      "--force",
      artifact.worktreePath,
    ],
    { timeout: 30_000 }
  )
  await rm(artifact.markerPath, { force: true })
  if (!input.keepBranch) {
    await execFileAsync(
      "git",
      [`--git-dir=${artifact.repositoryId}`, "branch", "-D", artifact.branch],
      { timeout: 30_000 }
    )
  }
  return settleSubagentArtifact(artifact.id, "resolved", {
    resolution: input.keepBranch
      ? "worktree_removed_branch_preserved"
      : "worktree_and_branch_removed",
    branch: artifact.branch,
  })
}
