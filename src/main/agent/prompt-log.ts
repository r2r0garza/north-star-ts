import { app } from "electron"
import { mkdir, writeFile } from "fs/promises"
import path from "path"
import type { Mode } from "../db/types"

// Debug aid (gated by the `logSystemPrompt` setting): dump each turn's assembled
// system prompt verbatim to system-prompt-logs/<mode> - <MM-DD-YYYY HH-MM-SS>.md,
// so the exact text sent to the model can be inspected without the gateway logs.
// Rooted at app.getAppPath() (project root in dev), matching prompts/ and skills/.

const LOG_DIR = "system-prompt-logs"

// Zero-pad to two digits for the filename timestamp.
function pad(n: number): string {
  return String(n).padStart(2, "0")
}

// Build the "<mode> - MM-DD-YYYY HH-MM-SS.md" file name from a Date (local time).
function logFileName(mode: Mode, when: Date): string {
  const date = `${pad(when.getMonth() + 1)}-${pad(when.getDate())}-${when.getFullYear()}`
  const time = `${pad(when.getHours())}-${pad(when.getMinutes())}-${pad(when.getSeconds())}`
  return `${mode} - ${date} ${time}.md`
}

// Write the verbatim system prompt to a timestamped file. Best-effort: a failure
// here must never break a turn, so callers ignore the rejection. Returns the path
// written (for logging) or null on failure.
export async function logSystemPrompt(
  mode: Mode,
  systemPrompt: string,
  when: Date = new Date()
): Promise<string | null> {
  try {
    const dir = path.join(app.getAppPath(), LOG_DIR)
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, logFileName(mode, when))
    await writeFile(file, systemPrompt, "utf-8")
    return file
  } catch (error) {
    console.warn("Could not write system-prompt log:", error)
    return null
  }
}
