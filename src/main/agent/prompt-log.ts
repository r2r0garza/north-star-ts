import { app } from "electron"
import { mkdir, writeFile } from "fs/promises"
import path from "path"
import type { Mode } from "../db/types"

// Debug aid (gated by the `logSystemPrompt` setting): dump each turn's assembled
// system prompt verbatim to system-prompt-logs/<mode> - <MM-DD-YYYY HH-MM-SS>.md,
// and every model round's full outgoing message list beside it as
// <mode> - <MM-DD-YYYY HH-MM-SS> - round <N>.json, so the exact request sent to
// the provider can be inspected without the gateway logs. Rooted at
// app.getAppPath() in dev (project root, matching prompts/ and skills/); in a
// packaged build that path is inside the read-only app bundle, so logs go under
// userData instead.

const LOG_DIR = "system-prompt-logs"

// Zero-pad to two digits for the filename timestamp.
function pad(n: number): string {
  return String(n).padStart(2, "0")
}

// Build the "<mode> - MM-DD-YYYY HH-MM-SS" file stem from a Date (local time).
function logFileStem(mode: Mode, when: Date): string {
  const date = `${pad(when.getMonth() + 1)}-${pad(when.getDate())}-${when.getFullYear()}`
  const time = `${pad(when.getHours())}-${pad(when.getMinutes())}-${pad(when.getSeconds())}`
  return `${mode} - ${date} ${time}`
}

export function promptLogDir(): string {
  return path.join(
    app.isPackaged ? app.getPath("userData") : app.getAppPath(),
    LOG_DIR
  )
}

async function writeLog(name: string, content: string): Promise<string | null> {
  try {
    const dir = promptLogDir()
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, name)
    await writeFile(file, content, "utf-8")
    return file
  } catch (error) {
    console.warn("Could not write system-prompt log:", error)
    return null
  }
}

// Write the verbatim system prompt to a timestamped file. Best-effort: a failure
// here must never break a turn, so callers ignore the rejection. Returns the path
// written (for logging) or null on failure.
export async function logSystemPrompt(
  mode: Mode,
  systemPrompt: string,
  when: Date = new Date()
): Promise<string | null> {
  return writeLog(`${logFileStem(mode, when)}.md`, systemPrompt)
}

// Inline image data URLs would bury the log in base64; keep their position and
// size so the message structure stays readable.
function redactImageData(_key: string, value: unknown): unknown {
  if (typeof value === "string" && value.startsWith("data:image/")) {
    const comma = value.indexOf(",")
    return `${value.slice(0, comma + 1)}<${value.length - comma - 1} chars omitted>`
  }
  return value
}

// Write one model round's full request (messages in order, roles intact, plus
// the offered tool names) as JSON. `turnStartedAt` groups a turn's rounds under
// one timestamp; `round` orders them. Same best-effort contract as above.
export async function logRequestMessages(input: {
  mode: Mode
  turnStartedAt: Date
  round: number
  model: string
  messages: unknown[]
  toolNames: string[]
}): Promise<string | null> {
  let body: string
  try {
    body = JSON.stringify(
      {
        round: input.round,
        model: input.model,
        loggedAt: new Date().toISOString(),
        tools: input.toolNames,
        messages: input.messages,
      },
      redactImageData,
      2
    )
  } catch (error) {
    console.warn("Could not serialize request log:", error)
    return null
  }
  return writeLog(
    `${logFileStem(input.mode, input.turnStartedAt)} - round ${input.round}.json`,
    body
  )
}
