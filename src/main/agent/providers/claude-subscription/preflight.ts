import type { ClaudeSubscriptionPreflight } from "../../../../shared/claude-subscription"
import { hostCliEnv } from "../../env/host-cli-env"
import {
  guardEnvironment,
  privateDirectories,
  probeCliVersion,
  resolveExecutable,
} from "./setup"
import {
  authCompatibilityHint,
  verifyPersonalSubscription,
  type AuthCompatibility,
} from "./auth-policy"
import { guardManagedPolicy } from "./managed-policy"
import { gatewayEnvironment, gatewayRoute } from "./gateway"
import { ClaudeSubscriptionError } from "./errors"

function safeAuthReason(error: ClaudeSubscriptionError): AuthCompatibility {
  const reason = (
    error as ClaudeSubscriptionError & { compatibility?: unknown }
  ).compatibility
  return typeof reason === "string" &&
    [
      "not_logged_in",
      "routing_unqualified",
      "organization_policy_unqualified",
      "authentication_unqualified",
    ].includes(reason)
    ? (reason as AuthCompatibility)
    : "status_unavailable"
}

const stageHints = {
  environment: "Could not read the host CLI environment.",
  gateway: "Could not inspect the static CLI gateway configuration.",
  environment_guard: "Could not validate the CLI environment.",
  executable: "Could not resolve the official CLI executable.",
  private_state:
    "Could not prepare private setup state. Check application-data access permissions.",
  version:
    "Could not probe the CLI version or its startup managed-policy sources.",
  authentication: "Could not verify CLI authentication metadata.",
  managed_policy:
    "Could not verify host managed-policy sources. Do not remove or bypass policy.",
} as const

const hints: Record<string, string> = {
  claude_subscription_managed_policy_probe:
    "Could not verify Claude managed-policy sources or macOS enrollment. Check whether the host permits policy inspection; do not remove or bypass policy.",
  claude_subscription_cli_probe:
    "The official CLI version probe failed or timed out. Confirm claude --version works on this host.",
  claude_subscription_private_state:
    "Private transport state could not be verified. Check application-data permissions; do not delete existing state to bypass this check.",
  claude_subscription_gateway_unqualified:
    "The static CLI gateway configuration is unqualified. HTTPS routing, static credentials and a supported wire protocol are required. Managed hosts/policy remain unsupported; do not bypass policy.",
  claude_subscription_cli_missing:
    "Install the official native Claude Code CLI yourself, then recheck. North Star does not install or update it.",
  claude_subscription_cli_shim:
    "Install the official native Claude Code executable, not a Windows command shim, then recheck.",
  claude_subscription_cli_incompatible:
    "Use stable Claude Code >=2.1.286 and <3.0.0, then recheck. Prerelease versions require compatibility review.",
  claude_subscription_environment:
    "The host environment conflicts with personal subscription setup. Review your provider configuration; do not bypass organization policy.",
  claude_subscription_proxy_unsupported:
    "Configured proxies are not supported by this experimental transport. Use an approved provider; North Star will not connect around your proxy.",
  claude_subscription_managed_policy:
    "Managed Claude policy was detected. Use an organization-approved provider; do not remove or bypass policy.",
  claude_subscription_platform_unqualified:
    "This host configuration is not qualified for the experimental subscription provider.",
}

export async function preflightClaudeSubscription(
  appData: string
): Promise<ClaudeSubscriptionPreflight> {
  const result: ClaudeSubscriptionPreflight = {
    ok: false,
    installed: null,
    version: null,
    compatible: null,
    loggedIn: null,
    hint: "Could not safely verify Claude subscription setup. Recheck the official CLI installation and host configuration.",
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60000)
  let files: Awaited<ReturnType<typeof privateDirectories>> | undefined
  let stage: keyof typeof stageHints = "environment"
  try {
    const hostEnv = await hostCliEnv()
    stage = "gateway"
    const gatewayEnv = await gatewayEnvironment(hostEnv)
    stage = "environment_guard"
    const env = guardEnvironment(gatewayEnv)
    stage = "executable"
    const executable = await resolveExecutable(env)
    result.installed = true
    stage = "private_state"
    files = await privateDirectories(appData, controller.signal)
    stage = "version"
    result.version = await probeCliVersion(
      executable,
      files.cwd,
      env,
      controller.signal
    )
    result.compatible = true
    stage = "authentication"
    await verifyPersonalSubscription(
      executable,
      files.cwd,
      env,
      controller.signal
    )
    result.loggedIn = true
    stage = "managed_policy"
    await guardManagedPolicy(env, controller.signal)
    result.ok = true
    result.hint = gatewayRoute(env)
      ? "Static gateway configuration and CLI authentication metadata verified; live gateway compatibility and entitlement are not established. Entries share the CLI-selected credentials and may incur API charges."
      : "Personal Pro/Max CLI login verified. All configured subscription entries share this official CLI login; model visibility does not establish entitlement."
  } catch (error) {
    result.hint = `${stageHints[stage]} [setup:${stage}]`
    if (controller.signal.aborted)
      result.hint = `CLI setup verification timed out. [setup:${stage}]`
    if (error instanceof ClaudeSubscriptionError) {
      if (error.code === "claude_subscription_cli_missing")
        result.installed = false
      if (error.code === "claude_subscription_cli_incompatible")
        result.compatible = false
      if (error.code === "claude_subscription_account_unqualified")
        result.hint = `${authCompatibilityHint(safeAuthReason(error))} [setup:${stage}:account_unqualified]`
      else if (Object.hasOwn(hints, error.code))
        result.hint = `${hints[error.code]} [setup:${stage}:${error.code.replace("claude_subscription_", "")}]`
    }
  } finally {
    clearTimeout(timeout)
    controller.abort()
    try {
      await files?.close()
    } catch {
      result.ok = false
      result.hint =
        "Could not clean up private setup state. Recheck the host configuration before saving this provider."
    }
  }
  return result
}
