import { spawn } from "child_process"
import { StringDecoder } from "string_decoder"
import { readGitBranch } from "../../index/metadata"
import { captureSpawn } from "../env/spawn-util"
import { hostCliEnv } from "../env/host-cli-env"
import type { CliTurnEvent } from "./claude"

// `gpt-5.3-codex` and its Spark variant are rejected outright ("not supported when
// using Codex with a ChatGPT account") on ChatGPT-auth logins, which is how the
// CLI is usually signed in — so the default must be a model both auth modes
// accept. Verified live against `codex exec`: gpt-5.5 and gpt-5.6-sol work.
export const CODEX_CLI_MODELS = [
  { id: "gpt-5.5", name: "GPT-5.5", favorite: true },
  { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", favorite: false },
  { id: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark", favorite: false },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", favorite: false },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", favorite: false },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", favorite: false },
] as const

export const DEFAULT_CODEX_CLI_MODEL = "gpt-5.5"

export function normalizeCodexModel(model: string | null | undefined): string {
  const value = model?.trim().toLowerCase()
  return !value || value === "codex-cli" ? DEFAULT_CODEX_CLI_MODEL : value
}

export interface CodexParseState {
  finalText?: string
  threadId?: string
  error?: string
  usage?: unknown
}

export function buildCodexArgs(input: {
  cwd: string
  message: string
  threadId?: string | null
  skipGitRepoCheck: boolean
  model?: string | null
  sandbox?: "read-only" | "workspace-write"
}): string[] {
  const args = [
    "exec",
    "--json",
    "--sandbox",
    input.sandbox ?? "read-only",
    "-C",
    input.cwd,
  ]
  args.push("--model", normalizeCodexModel(input.model))
  if (input.skipGitRepoCheck) args.push("--skip-git-repo-check")
  if (input.threadId) args.push("resume", input.threadId)
  args.push(input.message)
  return args
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return "{}"
  }
}

export function parseCodexEvent(
  value: unknown,
  emit: (event: CliTurnEvent) => void,
  state: CodexParseState
): void {
  if (!value || typeof value !== "object") return
  const event = value as Record<string, any>

  if (event.type === "thread.started" && typeof event.thread_id === "string") {
    state.threadId = event.thread_id
    return
  }

  if (event.type === "turn.completed") {
    state.usage = event.usage
    return
  }

  if (event.type === "error") {
    state.error =
      (typeof event.message === "string" && event.message) ||
      (typeof event.error === "string" && event.error) ||
      "Codex CLI reported an error."
    return
  }

  if (
    (event.type === "item.started" || event.type === "item.completed") &&
    event.item &&
    typeof event.item === "object"
  ) {
    const item = event.item as Record<string, any>
    const id = typeof item.id === "string" ? item.id : undefined
    if (item.type === "agent_message" && typeof item.text === "string") {
      state.finalText = item.text
      emit({ type: "text", text: item.text })
      return
    }
    if (item.type === "command_execution" && id) {
      const command =
        typeof item.command === "string" ? item.command : "Codex command"
      if (event.type === "item.started") {
        emit({
          type: "tool_start",
          id,
          name: command,
          arguments: stringify({ command }),
        })
      } else {
        const output =
          typeof item.aggregated_output === "string"
            ? item.aggregated_output
            : ""
        const status =
          typeof item.status === "string" ? `status: ${item.status}` : ""
        const exit =
          typeof item.exit_code === "number" ? `exit: ${item.exit_code}` : ""
        emit({
          type: "tool_done",
          id,
          name: command,
          result: [output, exit, status].filter(Boolean).join("\n"),
        })
      }
    }
  }
}

export async function detectCodexCli(cwd: string): Promise<{
  installed: boolean
  version?: string
  error?: string
}> {
  const child = spawn("codex", ["--version"], {
    cwd,
    env: await hostCliEnv(),
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  })
  const result = await captureSpawn(child, {
    timeoutMs: 5000,
    maxOutputBytes: 32 * 1024,
    killGroup: true,
  })
  const output = Buffer.concat(
    [result.stdout, result.stderr].filter(Boolean) as Buffer[]
  )
    .toString("utf8")
    .trim()
  const version = output.match(/codex(?:-cli)?\s+[^\s]+/i)?.[0]
  if (result.exitCode === 0) {
    return { installed: true, version: version ?? output.split(/\r?\n/)[0] }
  }
  return {
    installed: false,
    error: output || "Codex CLI was not found on PATH.",
  }
}

export async function runCodexCli(input: {
  cwd: string
  message: string
  threadId?: string | null
  model?: string | null
  signal: AbortSignal
  onEvent: (event: CliTurnEvent) => void
}): Promise<{
  content?: string
  threadId?: string
  error?: string
  stopped?: boolean
}> {
  const git = await readGitBranch(input.cwd)
  const child = spawn(
    "codex",
    buildCodexArgs({
      cwd: input.cwd,
      message: input.message,
      threadId: input.threadId,
      model: input.model,
      skipGitRepoCheck: git === null,
    }),
    {
      cwd: input.cwd,
      env: await hostCliEnv(),
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    }
  )

  const state: CodexParseState = {}
  const stderr: Buffer[] = []
  const decoder = new StringDecoder("utf8")
  let pending = ""
  const consumeLine = (line: string) => {
    if (!line.trim()) return
    try {
      parseCodexEvent(JSON.parse(line), input.onEvent, state)
    } catch {
      // Codex may print warnings around JSONL; only parsed events drive UI.
    }
  }
  child.stdout?.on("data", (chunk: Buffer) => {
    pending += decoder.write(chunk)
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ""
    for (const line of lines) consumeLine(line)
  })
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.reduce((n, part) => n + part.length, 0) < 256 * 1024) {
      stderr.push(chunk)
    }
  })

  const result = await captureSpawn(child, {
    timeoutMs: 24 * 60 * 60 * 1000,
    maxOutputBytes: 1,
    signal: input.signal,
    killGroup: true,
  })
  pending += decoder.end()
  consumeLine(pending)

  if (input.signal.aborted) return { stopped: true }
  if (state.error) return { error: state.error, threadId: state.threadId }
  if (result.exitCode !== 0) {
    const detail = Buffer.concat(stderr).toString("utf8").trim()
    const spawnError = result.stdout.toString("utf8").trim()
    return {
      threadId: state.threadId,
      error:
        detail ||
        spawnError ||
        `Codex CLI exited with status ${result.exitCode ?? result.signal ?? "unknown"}.`,
    }
  }
  if (!state.threadId) {
    return { error: "Codex CLI finished without returning a thread id." }
  }
  if (!state.finalText) {
    return {
      threadId: state.threadId,
      error: "Codex CLI finished without returning an assistant message.",
    }
  }
  return { content: state.finalText, threadId: state.threadId }
}
