import { existsSync } from "fs"
import { spawnSync } from "child_process"

import type { LocalProfileCapabilities, LocalRuntimeProfile } from "./types"

export const LOCAL_RUNTIME_PROFILES: LocalRuntimeProfile[] = [
  "host-access",
  "workspace-write",
  "read-only",
]

const SANDBOX_EXEC = "/usr/bin/sandbox-exec"

export function localProfileCapabilities(
  profile: LocalRuntimeProfile,
  platform: NodeJS.Platform = process.platform
): LocalProfileCapabilities {
  if (profile === "host-access") return { supported: true }
  if (platform !== "darwin") {
    return {
      supported: false,
      reason:
        "Local read-only/workspace-write profiles require a dependable platform sandbox adapter. Use a container backend or host-access on this platform.",
    }
  }
  if (!existsSync(SANDBOX_EXEC)) {
    return {
      supported: false,
      reason:
        "macOS sandbox-exec is unavailable. Use a container backend or host-access.",
    }
  }
  const probe = spawnSync(
    SANDBOX_EXEC,
    ["-p", "(version 1)\n(allow default)", "/usr/bin/true"],
    {
      encoding: "utf8",
      timeout: 2000,
    }
  )
  if (probe.status !== 0) {
    const detail = (probe.stderr || probe.error?.message || "").trim()
    return {
      supported: false,
      reason: detail
        ? `macOS sandbox-exec probe failed: ${detail}`
        : "macOS sandbox-exec probe failed. Use a container backend or host-access.",
    }
  }
  return { supported: true }
}

export function assertLocalProfileSupported(
  profile: LocalRuntimeProfile,
  platform: NodeJS.Platform = process.platform
): void {
  const caps = localProfileCapabilities(profile, platform)
  if (!caps.supported) {
    throw new Error(caps.reason ?? `Local profile is unavailable: ${profile}`)
  }
}

export function buildDarwinSandboxProfile(
  profile: Exclude<LocalRuntimeProfile, "host-access">,
  workspace: string
): string {
  const escapedWorkspace = escapeSeatbeltString(workspace)
  if (profile === "read-only") {
    return [
      "(version 1)",
      "(allow default)",
      "(deny network*)",
      "(deny file-write*)",
    ].join("\n")
  }
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(deny file-write*)",
    `(allow file-write* (subpath "${escapedWorkspace}"))`,
    `(allow file-write* (subpath "/private/tmp"))`,
    `(allow file-write* (subpath "/tmp"))`,
    `(allow file-write* (subpath "/private/var/folders"))`,
  ].join("\n")
}

export function sandboxExecPath(): string {
  return SANDBOX_EXEC
}

function escapeSeatbeltString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}
