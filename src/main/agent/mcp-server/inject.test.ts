import { mkdtemp, readFile, rm, stat } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, describe, expect, it } from "vitest"
import { buildClaudeArgs } from "../cli/claude"
import { buildCodexArgs } from "../cli/codex"
import {
  claudeMcpArgs,
  cliMcpEnv,
  codexMcpArgs,
  writeClaudeMcpConfig,
} from "./inject"
import type { CliMcpInjection } from "./types"

const INJECTION: CliMcpInjection = {
  url: "http://127.0.0.1:54321/mcp",
  tokenEnv: "NORTH_STAR_MCP_TOKEN",
  token: "grant-id.super-secret-value",
  allowedTools: ["mcp__north-star__ask_user_question"],
  systemPromptSteering:
    "You are running inside the North Star desktop app; ... call the " +
    "mcp__north-star__ask_user_question tool instead of writing the question as prose.",
  revoke: () => {},
}

const dirs: string[] = []
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ns-mcp-"))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))
  )
})

describe("Claude Code MCP injection", () => {
  it("writes an app-owned config with a placeholder, not the token", async () => {
    const dir = await scratch()
    const config = await writeClaudeMcpConfig(INJECTION, dir, "conv-session")
    const raw = await readFile(config.path, "utf8")
    expect(JSON.parse(raw)).toEqual({
      mcpServers: {
        "north-star": {
          type: "http",
          url: INJECTION.url,
          headers: { Authorization: "Bearer ${NORTH_STAR_MCP_TOKEN}" },
        },
      },
    })
    expect(raw).not.toContain(INJECTION.token)
    expect(raw).not.toContain("super-secret-value")

    await config.cleanup()
    await expect(stat(config.path)).rejects.toThrow()
    // Cleanup runs on every exit path, including one where it already ran.
    await expect(config.cleanup()).resolves.toBeUndefined()
  })

  it("appends the bridge to first-turn and resume argv without --strict-mcp-config", () => {
    const mcpArgs = claudeMcpArgs(INJECTION, "/data/cli-mcp-configs/conv.json")
    expect(mcpArgs).toEqual([
      "--mcp-config",
      "/data/cli-mcp-configs/conv.json",
      "--allowedTools",
      "mcp__north-star__ask_user_question",
      // Appends to Claude's own prompt; never --system-prompt, which replaces it.
      "--append-system-prompt",
      INJECTION.systemPromptSteering,
    ])

    for (const resume of [false, true]) {
      const args = buildClaudeArgs({
        message: "hello",
        sessionId: "session-id",
        resume,
        model: "sonnet",
        mcpArgs,
      })
      // Both argv shapes carry the whole injection, steering included.
      expect(args.slice(-mcpArgs.length)).toEqual(mcpArgs)
      expect(args).not.toContain("--strict-mcp-config")
      expect(args).not.toContain("--system-prompt")
      // The token is never an argument — a process listing must not reveal it.
      expect(args.join(" ")).not.toContain(INJECTION.token)
    }
  })

  it("omits --allowedTools and the steer when the grant is empty", () => {
    expect(
      claudeMcpArgs(
        { ...INJECTION, allowedTools: [], systemPromptSteering: null },
        "/tmp/c.json"
      )
    ).toEqual(["--mcp-config", "/tmp/c.json"])
  })

  it("carries the token and tool timeout only in the child environment", () => {
    const env = cliMcpEnv(INJECTION, "claude_code")
    expect(env.NORTH_STAR_MCP_TOKEN).toBe(INJECTION.token)
    expect(Number(env.MCP_TOOL_TIMEOUT)).toBeGreaterThan(60 * 60 * 1000)
  })
})

describe("Codex CLI MCP injection", () => {
  it("defines a transient server through global -c overrides", () => {
    const mcpArgs = codexMcpArgs(INJECTION)
    expect(mcpArgs).toEqual([
      "-c",
      'mcp_servers.north-star.url="http://127.0.0.1:54321/mcp"',
      "-c",
      'mcp_servers.north-star.bearer_token_env_var="NORTH_STAR_MCP_TOKEN"',
      "-c",
      "mcp_servers.north-star.tool_timeout_sec=3900",
    ])
  })

  it("prepends the overrides before exec and exec resume", () => {
    const mcpArgs = codexMcpArgs(INJECTION)
    for (const threadId of [null, "thread-7"]) {
      const args = buildCodexArgs({
        cwd: "/tmp/ws",
        message: "hello",
        threadId,
        skipGitRepoCheck: false,
        model: "gpt-5.3-codex",
        mcpArgs,
      })
      expect(args.slice(0, mcpArgs.length)).toEqual(mcpArgs)
      expect(args[mcpArgs.length]).toBe("exec")
      expect(args.join(" ")).not.toContain(INJECTION.token)
    }
    expect(
      buildCodexArgs({
        cwd: "/tmp/ws",
        message: "hello",
        threadId: "thread-7",
        skipGitRepoCheck: false,
        mcpArgs,
      })
    ).toContain("resume")
  })

  it("passes args as an array with no shell quoting layer", () => {
    const args = buildCodexArgs({
      cwd: "/tmp/ws",
      message: 'a "quoted" message; rm -rf /',
      skipGitRepoCheck: false,
      mcpArgs: codexMcpArgs(INJECTION),
    })
    expect(args.at(-1)).toBe('a "quoted" message; rm -rf /')
  })

  it("puts the token only in the child environment", () => {
    const env = cliMcpEnv(INJECTION, "codex_cli")
    expect(env).toEqual({ NORTH_STAR_MCP_TOKEN: INJECTION.token })
  })
})
