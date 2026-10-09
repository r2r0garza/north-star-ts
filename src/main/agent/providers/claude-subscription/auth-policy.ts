import { spawn } from "child_process"
import { captureProcess } from "../../env/spawn-util"
import { aborted, ClaudeSubscriptionError } from "./errors"

export function validatePersonalSubscription(output: string): void {
  let status: any
  try {
    status = JSON.parse(output)
  } catch {
    throw policyError()
  }
  if (
    !status ||
    typeof status !== "object" ||
    Array.isArray(status) ||
    status.loggedIn !== true ||
    status.authMethod !== "claude.ai" ||
    status.apiProvider !== "firstParty" ||
    !["pro", "max"].includes(status.subscriptionType)
  )
    throw policyError()
}

function policyError() {
  return new ClaudeSubscriptionError(
    "claude_subscription_account_unqualified",
    "This experimental transport requires a personal Claude Pro or Max login reported by the official CLI. Organization accounts, token-only credentials and unknown authentication states are unqualified. Use an organization-approved provider; do not remove or bypass policy."
  )
}

export async function verifyPersonalSubscription(
  executable: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) throw aborted()
  if (
    env.CLAUDE_CODE_OAUTH_TOKEN ||
    env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  )
    throw policyError()
  const result = await captureProcess(
    spawn(executable, ["auth", "status", "--json"], {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    }),
    { signal, timeoutMs: 5000, maxOutputBytes: 16384, killGroup: true }
  )
  if (signal.aborted || result.aborted) throw aborted()
  if (
    result.exitCode !== 0 ||
    result.signal ||
    result.spawnError ||
    result.timedOut ||
    result.outputTruncated
  )
    throw policyError()
  validatePersonalSubscription(result.stdout.toString("utf8"))
}
