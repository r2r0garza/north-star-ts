import { lstat } from "fs/promises"
import { homedir, userInfo } from "os"
import { spawn } from "child_process"
import { captureProcess } from "../../env/spawn-util"
import { join } from "path"
import { aborted, ClaudeSubscriptionError } from "./errors"

export async function guardManagedPolicy(
  env: NodeJS.ProcessEnv,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) throw aborted()
  if (process.platform !== "darwin")
    throw new ClaudeSubscriptionError(
      "claude_subscription_platform_unqualified",
      "Managed-policy qualification is currently limited to macOS."
    )
  const base = "/Library/Application Support/ClaudeCode"
  const preferences = "/Library/Managed Preferences"
  const domain = "com.anthropic.claudecode.plist"
  let username: string
  try {
    username = userInfo().username
  } catch {
    throw new ClaudeSubscriptionError(
      "claude_subscription_managed_policy_probe",
      "Could not check local Claude managed-policy sources. Recheck host configuration."
    )
  }
  const sources = [
    join(base, "managed-settings.json"),
    join(base, "managed-settings.d"),
    join(base, "managed-mcp.json"),
    join(preferences, domain),
    join(preferences, username, domain),
    join(
      env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude"),
      "remote-settings.json"
    ),
  ]
  for (const source of sources) {
    try {
      await lstat(source)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw new ClaudeSubscriptionError(
        "claude_subscription_managed_policy_probe",
        "Could not check local Claude managed-policy sources. Recheck host configuration."
      )
    }
    throw new ClaudeSubscriptionError(
      "claude_subscription_managed_policy",
      "Claude managed policy or a remote-policy cache is present. This experimental transport cannot verify compatibility with organization-managed settings. Use an organization-approved provider; do not remove or bypass policy."
    )
  }
  const result = await captureProcess(
    spawn("/usr/bin/profiles", ["status", "-type", "enrollment"], {
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    }),
    { signal, timeoutMs: 5000, maxOutputBytes: 4096, killGroup: true }
  )
  if (signal.aborted || result.aborted) throw aborted()
  if (
    result.exitCode !== 0 ||
    result.signal ||
    result.spawnError ||
    result.timedOut ||
    result.outputTruncated
  )
    throw new ClaudeSubscriptionError(
      "claude_subscription_managed_policy_probe",
      "Could not verify macOS management enrollment. Recheck host configuration."
    )
  const status = result.stdout.toString("utf8").trim()
  if (
    /^(?:Enrolled via DEP: (?:Yes|No)\r?\nMDM enrollment: (?:Yes(?: \(User Approved\))?|No))$/.test(
      status
    ) === false
  )
    throw new ClaudeSubscriptionError(
      "claude_subscription_managed_policy_probe",
      "Could not verify macOS management enrollment. Recheck host configuration."
    )
  if (
    status !== "Enrolled via DEP: No\nMDM enrollment: No" &&
    status !== "Enrolled via DEP: No\r\nMDM enrollment: No"
  )
    throw new ClaudeSubscriptionError(
      "claude_subscription_managed_policy",
      "This Mac is organization-managed. Managed-policy compatibility is unqualified; use an organization-approved provider and do not remove or bypass policy."
    )
}
