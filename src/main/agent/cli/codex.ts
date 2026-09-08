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

// ---------------------------------------------------------------------------
// The JSONL protocol `codex exec --json` speaks.
//
// These mirror the event types @openai/codex-sdk publishes for the same stream
// (it wraps this very CLI). We describe the protocol here rather than depend on
// that package: it pins an exact `@openai/codex` release and drags in a ~288MB
// platform binary, which would bypass the user's own `codex` login and bloat the
// packaged app. Types cost nothing; the binary is the whole package.
//
// The point is that parseCodexEvent below is checked against the real payload
// shapes. Reading fields off `Record<string, any>` is what let failed MCP tool
// calls render with an empty error string — `error` is an object, not a string.
// ---------------------------------------------------------------------------

export type CodexItemStatus = "in_progress" | "completed" | "failed"

export interface CodexAgentMessageItem {
  id: string
  type: "agent_message"
  text: string
}

export interface CodexReasoningItem {
  id: string
  type: "reasoning"
  text: string
}

export interface CodexCommandExecutionItem {
  id: string
  type: "command_execution"
  command: string
  aggregated_output: string
  // Absent while running, and explicitly `null` in the CLI's in-progress frames.
  exit_code?: number | null
  status: CodexItemStatus
}

export interface CodexFileChangeItem {
  id: string
  type: "file_change"
  changes: { path: string; kind: "add" | "delete" | "update" }[]
  status: "completed" | "failed"
}

export interface CodexMcpToolCallItem {
  id: string
  type: "mcp_tool_call"
  server: string
  tool: string
  arguments: unknown
  result?: unknown
  // An object — see the note above.
  error?: { message: string }
  status: CodexItemStatus
}

export interface CodexWebSearchItem {
  id: string
  type: "web_search"
  query: string
}

export interface CodexTodoListItem {
  id: string
  type: "todo_list"
  items: { text: string; completed: boolean }[]
}

export interface CodexErrorItem {
  id: string
  type: "error"
  message: string
}

export type CodexThreadItem =
  | CodexAgentMessageItem
  | CodexReasoningItem
  | CodexCommandExecutionItem
  | CodexFileChangeItem
  | CodexMcpToolCallItem
  | CodexWebSearchItem
  | CodexTodoListItem
  | CodexErrorItem

export interface CodexUsage {
  input_tokens: number
  cached_input_tokens: number
  cache_write_input_tokens: number
  output_tokens: number
  reasoning_output_tokens: number
}

export type CodexThreadEvent =
  | { type: "thread.started"; thread_id: string }
  | { type: "turn.started" }
  | { type: "turn.completed"; usage: CodexUsage }
  | { type: "turn.failed"; error?: { message?: string } }
  | { type: "item.started"; item: CodexThreadItem }
  | { type: "item.updated"; item: CodexThreadItem }
  | { type: "item.completed"; item: CodexThreadItem }
  // `error` is the shape the installed CLI emits; `message` is what current
  // releases carry. The stream is a cross-version contract we don't control, so
  // both spellings stay readable.
  | { type: "error"; message?: string; error?: string }

export interface CodexParseState {
  finalText?: string
  threadId?: string
  error?: string
  usage?: unknown
}

// The prompt travels on stdin, not argv. `-` is how `codex exec` is told to read
// it from there — and it is required for the `resume` subcommand, which unlike a
// first turn does NOT fall back to stdin when the prompt argument is missing.
// Both paths verified against codex-cli 0.149.1.
//
// Keeping the prompt out of argv avoids the ARG_MAX ceiling on long messages and
// stops it showing up in `ps`, the same reason the MCP bearer token is passed
// through the environment instead.
const CODEX_PROMPT_STDIN = "-"

export function buildCodexArgs(input: {
  cwd: string
  threadId?: string | null
  skipGitRepoCheck: boolean
  model?: string | null
  sandbox?: "read-only" | "workspace-write"
  // North Star MCP bridge overrides (plan 045). Global `-c` flags, so they are
  // prepended before the subcommand and apply to `exec` and `exec resume`
  // alike. Nothing is written to the user's ~/.codex/config.toml.
  mcpArgs?: string[]
}): string[] {
  const args = [
    ...(input.mcpArgs ?? []),
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
  args.push(CODEX_PROMPT_STDIN)
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
  // The single unchecked boundary: JSON.parse hands back `unknown` and the CLI
  // is the only writer. Every field access past here is type-checked, with
  // runtime guards kept on the strings that reach the UI.
  const event = value as CodexThreadEvent

  switch (event.type) {
    case "thread.started":
      if (typeof event.thread_id === "string") state.threadId = event.thread_id
      return
    case "turn.completed":
      state.usage = event.usage
      return
    // Previously unhandled, so a failed turn fell through to the generic "no
    // assistant message" error and lost the CLI's actual reason.
    case "turn.failed":
      state.error = event.error?.message || "Codex CLI reported an error."
      return
    case "error":
      state.error =
        event.message || event.error || "Codex CLI reported an error."
      return
    case "item.started":
    case "item.completed":
      break
    default:
      return
  }

  const item = event.item
  if (!item || typeof item !== "object") return
  const started = event.type === "item.started"

  if (item.type === "agent_message") {
    if (typeof item.text !== "string") return
    state.finalText = item.text
    emit({ type: "text", text: item.text })
    return
  }

  const id = typeof item.id === "string" ? item.id : undefined
  if (!id) return

  // MCP tool calls (including North Star's own bridge, plan 045) so the
  // transcript shows `north-star · ask_user_question` while the turn waits on
  // the question panel, rather than a silent gap.
  if (item.type === "mcp_tool_call") {
    const server = typeof item.server === "string" ? item.server : "mcp"
    const tool = typeof item.tool === "string" ? item.tool : "tool"
    const name = `${server} · ${tool}`
    if (started) {
      emit({
        type: "tool_start",
        id,
        name,
        arguments: stringify(item.arguments ?? {}),
      })
    } else {
      const status =
        typeof item.status === "string" ? `status: ${item.status}` : ""
      const error = item.error?.message ?? ""
      emit({
        type: "tool_done",
        id,
        name,
        result: [stringify(item.result ?? ""), error, status]
          .filter(Boolean)
          .join("\n"),
      })
    }
    return
  }

  if (item.type === "command_execution") {
    const command =
      typeof item.command === "string" ? item.command : "Codex command"
    if (started) {
      emit({
        type: "tool_start",
        id,
        name: command,
        arguments: stringify({ command }),
      })
    } else {
      const output =
        typeof item.aggregated_output === "string" ? item.aggregated_output : ""
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
  mcpArgs?: string[]
  // Merged over the host CLI environment. Carries the MCP bearer token, which
  // must never reach argv.
  extraEnv?: NodeJS.ProcessEnv
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
      threadId: input.threadId,
      model: input.model,
      skipGitRepoCheck: git === null,
      mcpArgs: input.mcpArgs,
    }),
    {
      cwd: input.cwd,
      env: { ...(await hostCliEnv()), ...input.extraEnv },
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    }
  )

  // The prompt, then EOF — the CLI blocks on stdin until the stream closes.
  // A turn killed before the write lands surfaces as EPIPE, which is not a
  // failure worth reporting over the abort itself.
  child.stdin?.on("error", () => {})
  child.stdin?.end(input.message)

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
