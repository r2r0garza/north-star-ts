import { readFile } from "fs/promises"
import { homedir } from "os"
import { join } from "path"
import { ClaudeSubscriptionError } from "./errors"

export interface GatewayRoute {
  upstream: string
  protocol: "messages" | "bedrock"
}

const allowed = new Set([
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_MODEL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_ENABLE_AUTO_MODE",
])

function incompatible(): never {
  throw new ClaudeSubscriptionError(
    "claude_subscription_gateway_unqualified",
    "The CLI gateway configuration (ANTHROPIC_BASE_URL) is not qualified. Static HTTPS Messages gateways and skip-auth Bedrock gateways are supported only on hosts without detected managed policy. Credential helpers, alternate cloud routes, proxies and managed hosts require separate qualification; do not change organization policy to enable this provider."
  )
}

export function gatewayRoute(env: NodeJS.ProcessEnv): GatewayRoute | undefined {
  if (!env.ANTHROPIC_BASE_URL) return undefined
  if (
    Object.entries(env).some(
      ([key, value]) =>
        value &&
        /^(?:CLAUDE_CODE_(?:USE_VERTEX|USE_FOUNDRY|USE_MANTLE|USE_ANTHROPIC_AWS|USE_GATEWAY|USE_ANTHROPIC_GOOGLE_CLOUD)|ANTHROPIC_(?:BEDROCK|VERTEX|FOUNDRY|AWS|GOOGLE_CLOUD)_|AWS_BEARER_TOKEN_BEDROCK|CLAUDE_CODE_OAUTH_TOKEN)/i.test(
          key
        )
    )
  )
    incompatible()
  let url: URL
  try {
    url = new URL(env.ANTHROPIC_BASE_URL)
  } catch {
    return incompatible()
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    incompatible()
  if (!env.ANTHROPIC_AUTH_TOKEN && !env.ANTHROPIC_API_KEY) incompatible()
  if (env.CLAUDE_CODE_USE_BEDROCK && env.CLAUDE_CODE_USE_BEDROCK !== "0") {
    if (
      env.CLAUDE_CODE_USE_BEDROCK !== "1" ||
      env.CLAUDE_CODE_SKIP_BEDROCK_AUTH !== "1" ||
      !env.ANTHROPIC_AUTH_TOKEN
    )
      incompatible()
    return { upstream: url.href, protocol: "bedrock" }
  }
  return { upstream: url.href, protocol: "messages" }
}

// Read only the user's static gateway env; never load settings as executable configuration.
export async function gatewayEnvironment(
  env: NodeJS.ProcessEnv
): Promise<NodeJS.ProcessEnv> {
  let settings: any
  try {
    const raw = await readFile(
      join(env.HOME || env.USERPROFILE || homedir(), ".claude", "settings.json")
    )
    if (raw.length > 1024 * 1024) incompatible()
    settings = JSON.parse(raw.toString("utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return env
    incompatible()
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    incompatible()
  const configured = settings.env
  if (!configured?.ANTHROPIC_BASE_URL && !env.ANTHROPIC_BASE_URL) return env
  if (
    settings.apiKeyHelper ||
    settings.forceLoginMethod ||
    settings.forceLoginOrgUUID
  )
    incompatible()
  const merged = { ...env }
  if (
    configured &&
    (typeof configured !== "object" || Array.isArray(configured))
  )
    incompatible()
  for (const [key, value] of Object.entries(configured ?? {})) {
    if (typeof value !== "string") incompatible()
    if (allowed.has(key)) merged[key] = value as string
    else if (
      /^(?:ANTHROPIC_|CLAUDE_CODE_(?:USE_|SKIP_.*AUTH)|AWS_|HTTPS?_PROXY|ALL_PROXY|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED)/i.test(
        key
      )
    )
      incompatible()
  }
  gatewayRoute(merged)
  return merged
}

export function gatewayChildEnvironment(
  env: NodeJS.ProcessEnv,
  baseUrl: string
): NodeJS.ProcessEnv {
  const route = gatewayRoute(env)
  return {
    ...env,
    ANTHROPIC_BASE_URL: baseUrl,
    ...(route?.protocol === "bedrock"
      ? { ANTHROPIC_BEDROCK_BASE_URL: baseUrl }
      : {}),
  }
}

export function gatewayVariable(key: string): boolean {
  return allowed.has(key)
}
