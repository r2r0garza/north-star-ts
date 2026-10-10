import { spawn } from "child_process"
import { captureProcess } from "../../env/spawn-util"
import { aborted, ClaudeSubscriptionError } from "./errors"
import { gatewayRoute, gatewayChildEnvironment } from "./gateway"
import { createServer } from "http"
import type { AddressInfo } from "net"

export type AuthCompatibility =
  | "qualified_personal"
  | "status_unavailable"
  | "not_logged_in"
  | "routing_unqualified"
  | "organization_policy_unqualified"
  | "authentication_unqualified"

export function assessAuthCompatibility(output: string): AuthCompatibility {
  let status: any
  try {
    status = JSON.parse(output)
  } catch {
    return "status_unavailable"
  }
  if (!status || typeof status !== "object" || Array.isArray(status))
    return "status_unavailable"
  if (status.loggedIn === false) return "not_logged_in"
  if (status.loggedIn !== true) return "status_unavailable"
  if (status.apiProvider !== "firstParty") return "routing_unqualified"
  if (["team", "enterprise"].includes(status.subscriptionType))
    return "organization_policy_unqualified"
  if (
    status.authMethod !== "claude.ai" ||
    !["pro", "max"].includes(status.subscriptionType)
  )
    return "authentication_unqualified"
  return "qualified_personal"
}

export function validatePersonalSubscription(output: string): void {
  const compatibility = assessAuthCompatibility(output)
  if (compatibility !== "qualified_personal") throw policyError(compatibility)
}

export function authCompatibilityHint(reason: AuthCompatibility): string {
  const explanations: Record<AuthCompatibility, string> = {
    qualified_personal: "",
    status_unavailable:
      "The official CLI authentication status could not be verified.",
    not_logged_in: "The official CLI reports no active login.",
    routing_unqualified:
      "The CLI-selected routing is unqualified for the fixed first-party transport.",
    organization_policy_unqualified:
      "Organization authentication requires generation-child managed-policy continuity, which this transport cannot yet establish.",
    authentication_unqualified:
      "The CLI-selected authentication mode is unqualified; unknown metadata is not proof of incompatibility or inference entitlement.",
  }
  return `${explanations[reason]} This release requires a personal Claude Pro or Max login reported by the official CLI. Use a qualified or organization-approved provider; do not remove or bypass policy.`
}

function policyError(reason: AuthCompatibility = "status_unavailable") {
  return Object.assign(
    new ClaudeSubscriptionError(
      "claude_subscription_account_unqualified",
      authCompatibilityHint(reason)
    ),
    { compatibility: reason }
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
    Object.entries(env).some(
      ([key, value]) =>
        /^CLAUDE_CODE_OAUTH_TOKEN(?:_FILE_DESCRIPTOR)?$/i.test(key) && value
    )
  )
    throw policyError()
  const gateway = gatewayRoute(env)
  const sink = gateway
    ? createServer((_req, res) => res.writeHead(404).end())
    : undefined
  if (sink)
    await new Promise<void>((resolve, reject) => {
      sink.once("error", reject)
      sink.listen(0, "127.0.0.1", resolve)
    })
  let result: Awaited<ReturnType<typeof captureProcess>>
  try {
    result = await captureProcess(
      spawn(
        executable,
        [
          ...(gateway ? ["--setting-sources", ""] : []),
          "auth",
          "status",
          "--json",
        ],
        {
          cwd,
          env: sink
            ? gatewayChildEnvironment(
                env,
                `http://127.0.0.1:${(sink.address() as AddressInfo).port}`
              )
            : env,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        }
      ),
      { signal, timeoutMs: 5000, maxOutputBytes: 16384, killGroup: true }
    )
  } finally {
    if (sink) {
      sink.closeAllConnections()
      await new Promise<void>((resolve) => sink.close(() => resolve()))
    }
  }
  if (signal.aborted || result.aborted) throw aborted()
  if (
    result.exitCode !== 0 ||
    result.signal ||
    result.spawnError ||
    result.timedOut ||
    result.outputTruncated
  )
    throw policyError()
  if (gateway) {
    let status: any
    try {
      status = JSON.parse(result.stdout.toString("utf8"))
    } catch {
      throw policyError()
    }
    if (
      status.loggedIn !== true ||
      status.apiProvider !==
        (gateway.protocol === "bedrock" ? "bedrock" : "firstParty") ||
      !["api_key", "oauth_token", "third_party"].includes(status.authMethod)
    )
      throw policyError("authentication_unqualified")
  } else validatePersonalSubscription(result.stdout.toString("utf8"))
}
