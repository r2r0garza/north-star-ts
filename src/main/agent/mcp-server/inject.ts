import { mkdir, rm, writeFile } from "fs/promises"
import { join } from "path"
import { QUESTION_TIMEOUT_MS } from "./tools/ask-user-question"
import { CLI_MCP_SERVER_NAME, type CliMcpInjection } from "./types"

// Both CLIs must be willing to wait out a human. We give them a margin over our
// own bounded expiry so the North Star timeout is the one that fires — the CLI
// then gets a normal "dismissed" tool result instead of a transport error.
const CLIENT_TOOL_TIMEOUT_MS = QUESTION_TIMEOUT_MS + 5 * 60 * 1000

// The token never appears in the generated config, only this placeholder;
// Claude expands it from the child environment.
function claudeMcpConfig(injection: CliMcpInjection): string {
  return JSON.stringify(
    {
      mcpServers: {
        [CLI_MCP_SERVER_NAME]: {
          type: "http",
          url: injection.url,
          headers: {
            Authorization: `Bearer \${${injection.tokenEnv}}`,
          },
        },
      },
    },
    null,
    2
  )
}

export interface ClaudeMcpConfigFile {
  path: string
  cleanup: () => Promise<void>
}

// Write the app-owned session config. Never touches the user's or the project's
// MCP files, and `--strict-mcp-config` is deliberately not passed, so their own
// servers keep loading.
export async function writeClaudeMcpConfig(
  injection: CliMcpInjection,
  dir: string,
  name: string
): Promise<ClaudeMcpConfigFile> {
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${name}.json`)
  await writeFile(path, claudeMcpConfig(injection), "utf8")
  return {
    path,
    cleanup: () => rm(path, { force: true }).catch(() => {}),
  }
}

// argv appended to both first-turn and resume commands. Claude's `--allowedTools`
// only widens permission; the security boundary stays server-side.
// `--append-system-prompt` ADDS to Claude's own prompt rather than replacing it
// (that's `--system-prompt`), and rides here so it can never be attached to one
// argv shape and forgotten on the other.
export function claudeMcpArgs(
  injection: CliMcpInjection,
  configPath: string
): string[] {
  const args = ["--mcp-config", configPath]
  if (injection.allowedTools.length > 0) {
    args.push("--allowedTools", injection.allowedTools.join(","))
  }
  if (injection.systemPromptSteering) {
    args.push("--append-system-prompt", injection.systemPromptSteering)
  }
  return args
}

// TOML scalar for a `-c key=value` override. Codex parses the value as TOML, so
// strings must be quoted; the URL is app-generated and contains no quotes, but
// escape anyway rather than trusting that.
function toml(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

// Global `-c` overrides, prepended before `exec`, defining a transient
// `mcp_servers.north-star` entry. Nothing is written to ~/.codex/config.toml,
// and the token is read from the child environment rather than embedded.
export function codexMcpArgs(injection: CliMcpInjection): string[] {
  const key = `mcp_servers.${CLI_MCP_SERVER_NAME}`
  return [
    "-c",
    `${key}.url=${toml(injection.url)}`,
    "-c",
    `${key}.bearer_token_env_var=${toml(injection.tokenEnv)}`,
    "-c",
    `${key}.tool_timeout_sec=${Math.ceil(CLIENT_TOOL_TIMEOUT_MS / 1000)}`,
  ]
}

// The single token plus each CLI's tool-timeout knob, merged into the child env
// by the runner. Kept out of argv, where a process listing would expose it.
export function cliMcpEnv(
  injection: CliMcpInjection,
  provider: "claude_code" | "codex_cli"
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { [injection.tokenEnv]: injection.token }
  if (provider === "claude_code") {
    env.MCP_TOOL_TIMEOUT = String(CLIENT_TOOL_TIMEOUT_MS)
  }
  return env
}
