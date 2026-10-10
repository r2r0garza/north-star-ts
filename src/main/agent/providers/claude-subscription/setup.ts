import { constants } from "fs"
import { spawn } from "child_process"
import { captureProcess } from "../../env/spawn-util"
import { aborted } from "./errors"
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from "fs/promises"
import { delimiter, join, resolve, relative, isAbsolute } from "path"
import { windowsPrivatePath, windowsPrivatePaths } from "./windows-state"
import { ClaudeSubscriptionError } from "./errors"
import { guardProxyEnvironment } from "./admission"
import { guardManagedPolicy } from "./managed-policy"
import { verifyPersonalSubscription } from "./auth-policy"

const conflicts =
  /^(?:ANTHROPIC_(?:API_KEY|AUTH_TOKEN|BASE_URL|CUSTOM_HEADERS|PROFILE|FEDERATION_RULE_ID|ORGANIZATION_ID|WORKSPACE_ID|AWS_.*|FOUNDRY_.*|BEDROCK_.*|VERTEX_.*)|CLAUDE_CODE_(?:USE_BEDROCK|USE_VERTEX|USE_FOUNDRY|USE_MANTLE|USE_ANTHROPIC_AWS|SIMPLE|RESTRICTED|PROCESS_WRAPPER|SHELL_PREFIX|CLIENT_CERT|CLIENT_KEY|CLIENT_KEY_PASSPHRASE)|AWS_BEARER_TOKEN_BEDROCK|CLAUDE_CONFIG_DIR|CLAUDE_CODE_SAFE_MODE)$/
export function guardEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const found = Object.keys(env).filter(
    (key) => conflicts.test(key.toUpperCase()) && env[key]
  )
  if (found.length)
    throw new ClaudeSubscriptionError(
      "claude_subscription_environment",
      `Conflicting subscription environment variables: ${found.join(", ")}.`
    )
  guardProxyEnvironment(env)
  const clean = { ...env }
  for (const key of Object.keys(clean)) {
    if (
      /^(?:CLAUDE_CODE_(?:EXTRA_BODY|EFFORT_LEVEL|MAX_OUTPUT_TOKENS|SETTINGS|CONFIG|DEBUG|PLUGIN_|SYNC_|ENABLE_TELEMETRY|OTEL_|RETRY_WATCHDOG|RESUME_|FORCE_SESSION_PERSISTENCE|ENABLE_BACKGROUND_PLUGIN_REFRESH|DISABLE_THINKING|DISABLE_ADAPTIVE_THINKING|DISABLE_STRUCTURED_OUTPUTS|DISABLE_EXPERIMENTAL_BETAS|ALWAYS_ENABLE_EFFORT)|ANTHROPIC_(?:MODEL|DEFAULT_|CUSTOM_MODEL_|SMALL_FAST_MODEL|BETAS)|OTEL_|DEBUG$|ENABLE_BETA_TRACING_DETAILED$|BETA_TRACING_ENDPOINT$|FORCE_AUTOUPDATE_PLUGINS$|MAX_THINKING_TOKENS$|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$|NODE_TLS_REJECT_UNAUTHORIZED$|SSLKEYLOGFILE$)/i.test(
        key
      )
    )
      delete clean[key]
  }
  return {
    ...clean,
    DISABLE_AUTOUPDATER: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_TELEMETRY: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    DISABLE_AUTO_COMPACT: "1",
    ENABLE_TOOL_SEARCH: "false",
    CLAUDE_CODE_MAX_RETRIES: "0",
    CLAUDE_CODE_DISABLE_1M_CONTEXT: "1",
    CLAUDE_CODE_RETRY_WATCHDOG: "0",
    CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: "1",
    CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES: "0",
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
    CLAUDE_CODE_AUTO_CONNECT_IDE: "false",
    CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "0",
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    CLAUDE_CODE_ENABLE_TELEMETRY: "0",
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    CLAUDE_CODE_DISABLE_WORKFLOWS: "1",
    CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1",
  }
}

export async function resolveExecutable(
  env: NodeJS.ProcessEnv
): Promise<string> {
  for (const dir of (
    Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? ""
  )
    .split(delimiter)
    .filter(Boolean)) {
    if (!isAbsolute(dir)) continue
    for (const name of process.platform === "win32"
      ? ["claude.exe", "claude.cmd"]
      : ["claude"]) {
      const file = join(dir, name)
      try {
        await access(file, constants.X_OK)
        if (name.endsWith(".cmd"))
          throw new ClaudeSubscriptionError(
            "claude_subscription_cli_shim",
            "Install the native Claude executable; Windows npm command shims are not supported."
          )
        const target = await realpath(file)
        if ((await lstat(target)).isFile()) return target
      } catch (error) {
        if (error instanceof ClaudeSubscriptionError) throw error
      }
    }
  }
  throw new ClaudeSubscriptionError(
    "claude_subscription_cli_missing",
    "The official Claude executable was not found on the host PATH."
  )
}

export async function privateDirectories(
  appData: string,
  signal = new AbortController().signal
) {
  const parent = await realpath(appData)
  const root = join(parent, "claude-subscription-transport")
  if (process.platform === "win32") await windowsPrivatePath(root, true, signal)
  else
    await mkdir(root, { mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error
    })
  const verify = async (path: string) => {
    const stat = await lstat(path)
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (process.platform !== "win32" &&
        ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
    ) {
      throw new ClaudeSubscriptionError(
        "claude_subscription_private_state",
        "Subscription transport directory is not trusted private state."
      )
    }
  }
  await verify(root)
  const cwd = join(root, "cwd")
  await mkdir(cwd, { mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error
  })
  await verify(cwd)

  if ((await readdir(cwd)).length)
    throw new ClaudeSubscriptionError(
      "claude_subscription_private_state",
      "Subscription transport working directory must be empty."
    )
  const directory = await mkdtemp(join(root, "request-"))
  if (process.platform === "win32") {
    try {
      await windowsPrivatePaths([{ path: cwd }, { path: directory }], signal)
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
  }
  return {
    cwd,
    directory,
    async file(name: string, value: string) {
      return (await this.files([{ name, value }]))[0]
    },
    async files(entries: { name: string; value: string }[]) {
      const paths: string[] = []
      for (const { name, value } of entries) {
        const path = resolve(directory, name)
        const confined = relative(directory, path)
        if (
          !confined ||
          confined === ".." ||
          confined.startsWith("..\\") ||
          confined.startsWith("../") ||
          isAbsolute(confined) ||
          name.includes(":")
        )
          throw new Error("Invalid private file")
        await writeFile(path, value, { mode: 0o600, flag: "wx" })
        paths.push(path)
      }
      if (process.platform === "win32")
        await windowsPrivatePaths(
          paths.map((path) => ({ path })),
          signal
        )
      return paths
    },
    close: () =>
      rm(directory, {
        recursive: true,
        force: true,
        maxRetries: process.platform === "win32" ? 10 : 0,
        retryDelay: 100,
      }),
  }
}

export const MINIMUM_CLAUDE_CODE_VERSION = "2.1.286"

export function compatibleVersion(
  output: string,
  platform = process.platform
): string {
  const match =
    /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)) \(Claude Code\)[\r\n]*$/.exec(
      output
    )
  const parts = match?.[1].split(".").map(Number)
  const minimum = MINIMUM_CLAUDE_CODE_VERSION.split(".").map(Number)
  if (
    !parts ||
    !parts.every(Number.isSafeInteger) ||
    parts[0] !== minimum[0] ||
    parts[1] < minimum[1] ||
    (parts[1] === minimum[1] && parts[2] < minimum[2])
  ) {
    throw new ClaudeSubscriptionError(
      "claude_subscription_cli_incompatible",
      `This experimental transport requires stable Claude Code ${MINIMUM_CLAUDE_CODE_VERSION} or newer within 2.x. Upgrade older installations and recheck; prerelease and new major versions require compatibility review.`
    )
  }
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
    throw new ClaudeSubscriptionError(
      "claude_subscription_platform_unqualified",
      "This experimental transport is qualified on native macOS, Linux and Windows. Other platforms require separate qualification."
    )
  }
  return match![1]
}

export async function probeCliVersion(
  executable: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal
): Promise<string> {
  if (signal.aborted) throw aborted()
  await guardManagedPolicy(env, signal)
  if (signal.aborted) throw aborted()
  const child = spawn(executable, ["--version"], {
    cwd,
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  })
  const result = await captureProcess(child, {
    signal,
    timeoutMs: 5000,
    maxOutputBytes: 4096,
    killGroup: true,
  })
  if (signal.aborted || result.aborted) throw aborted()
  if (
    result.exitCode !== 0 ||
    result.signal ||
    result.spawnError ||
    result.timedOut ||
    result.outputTruncated
  ) {
    throw new ClaudeSubscriptionError(
      "claude_subscription_cli_probe",
      "Could not verify the installed Claude Code version. Recheck the official CLI installation."
    )
  }
  return compatibleVersion(result.stdout.toString("utf8"))
}

export async function verifyCliCompatibility(
  executable: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal
): Promise<string> {
  const version = await probeCliVersion(executable, cwd, env, signal)
  await verifyPersonalSubscription(executable, cwd, env, signal)
  await guardManagedPolicy(env, signal)
  return version
}
