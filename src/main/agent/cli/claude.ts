import { spawn } from "child_process"
import { StringDecoder } from "string_decoder"
import { captureSpawn } from "../env/spawn-util"
import { hostCliEnv } from "../env/host-cli-env"

export const CLAUDE_CODE_MODELS = [
  { id: "sonnet", name: "Sonnet", favorite: true },
  { id: "haiku", name: "Haiku", favorite: false },
  { id: "opus", name: "Opus", favorite: false },
  { id: "fable", name: "Fable", favorite: false },
] as const

export const DEFAULT_CLAUDE_CODE_MODEL = "sonnet"

export function normalizeClaudeModel(model: string | null | undefined): string {
  const value = model?.trim().toLowerCase()
  return !value || value === "claude-code" ? DEFAULT_CLAUDE_CODE_MODEL : value
}

export interface CliTurnEvent {
  type: "text" | "tool_start" | "tool_done"
  text?: string
  id?: string
  name?: string
  arguments?: string
  result?: string
}

export interface ClaudeParseState {
  finalText?: string
  sessionId?: string
  error?: string
}

export function buildClaudeArgs(input: {
  message: string
  sessionId: string
  resume: boolean
  model: string
  isolated?: boolean
  systemPrompt?: string
}): string[] {
  const args = input.resume
    ? [
        "-p",
        input.message,
        "--resume",
        input.sessionId,
        "--output-format",
        "stream-json",
        "--verbose",
      ]
    : [
        "-p",
        input.message,
        "--session-id",
        input.sessionId,
        "--output-format",
        "stream-json",
        "--verbose",
      ]
  args.push("--model", normalizeClaudeModel(input.model))
  if (input.isolated) {
    args.push("--no-session-persistence", "--safe-mode", "--tools", "")
  }
  if (input.systemPrompt) {
    args.push("--system-prompt", input.systemPrompt)
  }
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

export function parseClaudeEvent(
  value: unknown,
  emit: (event: CliTurnEvent) => void,
  state: ClaudeParseState
): void {
  if (!value || typeof value !== "object") return
  const event = value as Record<string, any>
  if (typeof event.session_id === "string") state.sessionId = event.session_id

  if (event.type === "assistant" && Array.isArray(event.message?.content)) {
    for (const block of event.message.content) {
      if (block?.type === "text" && typeof block.text === "string") {
        emit({ type: "text", text: block.text })
      } else if (
        block?.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string"
      ) {
        emit({
          type: "tool_start",
          id: block.id,
          name: block.name,
          arguments: stringify(block.input),
        })
      }
    }
    return
  }

  if (event.type === "user" && Array.isArray(event.message?.content)) {
    for (const block of event.message.content) {
      if (
        block?.type !== "tool_result" ||
        typeof block.tool_use_id !== "string"
      )
        continue
      const output = event.tool_use_result
      const stdout = typeof output?.stdout === "string" ? output.stdout : ""
      const stderr = typeof output?.stderr === "string" ? output.stderr : ""
      const fallback = stringify(block.content)
      emit({
        type: "tool_done",
        id: block.tool_use_id,
        name: "Claude tool",
        result: [stdout, stderr].filter(Boolean).join("\n") || fallback,
      })
    }
    return
  }

  if (event.type === "result") {
    if (typeof event.result === "string") state.finalText = event.result
    if (event.is_error) {
      state.error =
        (typeof event.result === "string" && event.result) ||
        (typeof event.error === "string" && event.error) ||
        "Claude Code reported an error."
    }
  }
}

export async function detectClaudeCode(cwd: string): Promise<{
  installed: boolean
  version?: string
  error?: string
}> {
  const child = spawn("claude", ["--version"], {
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
  const output = result.stdout.toString("utf8").trim()
  if (result.exitCode === 0) return { installed: true, version: output }
  return {
    installed: false,
    error: output || "Claude Code was not found on PATH.",
  }
}

export async function runClaudeCode(input: {
  cwd: string
  message: string
  sessionId: string
  resume: boolean
  model: string
  signal: AbortSignal
  onEvent: (event: CliTurnEvent) => void
  isolated?: boolean
  systemPrompt?: string
}): Promise<{ content?: string; error?: string; stopped?: boolean }> {
  const child = spawn(
    "claude",
    buildClaudeArgs({
      message: input.message,
      sessionId: input.sessionId,
      resume: input.resume,
      model: input.model,
      isolated: input.isolated,
      systemPrompt: input.systemPrompt,
    }),
    {
      cwd: input.cwd,
      env: await hostCliEnv(),
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    }
  )

  const state: ClaudeParseState = {}
  const stderr: Buffer[] = []
  const decoder = new StringDecoder("utf8")
  let pending = ""
  const consumeLine = (line: string) => {
    if (!line.trim()) return
    try {
      parseClaudeEvent(JSON.parse(line), input.onEvent, state)
    } catch {
      // Unknown/non-JSON stdout is diagnostic noise, not assistant chat text.
    }
  }
  child.stdout?.on("data", (chunk: Buffer) => {
    pending += decoder.write(chunk)
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ""
    for (const line of lines) consumeLine(line)
  })
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.reduce((n, part) => n + part.length, 0) < 256 * 1024)
      stderr.push(chunk)
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
  if (state.error) return { error: state.error }
  if (result.exitCode !== 0) {
    const detail = Buffer.concat(stderr).toString("utf8").trim()
    const spawnError = result.stdout.toString("utf8").trim()
    return {
      error:
        detail ||
        spawnError ||
        `Claude Code exited with status ${result.exitCode ?? result.signal ?? "unknown"}.`,
    }
  }
  if (!state.finalText) {
    return { error: "Claude Code finished without returning a final result." }
  }
  return { content: state.finalText }
}
