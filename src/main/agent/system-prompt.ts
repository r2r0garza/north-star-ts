import { app } from "electron"
import { readFile } from "fs/promises"
import path from "path"

// The agent's base system prompt lives in prompts/system-prompt.md so it can be
// edited without touching code. `app.getAppPath()` resolves to the project root
// in dev and the app bundle when packaged (the prompts/ dir is shipped via the
// build.files entry in package.json). The skills section is appended elsewhere.

// Fallback used only if the file is missing or unreadable, so the agent still
// works rather than crashing.
const FALLBACK =
  "You are a helpful assistant working inside a user-selected workspace directory. " +
  "You have access to tools that run on the server, confined to that workspace. " +
  "Use them when relevant to the user's request."

let cached: string | undefined

// Returns the base system prompt, loading it from disk once and caching it.
export async function loadSystemPrompt(): Promise<string> {
  if (cached !== undefined) return cached
  try {
    const file = path.join(app.getAppPath(), "prompts", "system-prompt.md")
    const text = (await readFile(file, "utf-8")).trim()
    cached = text || FALLBACK
  } catch (error) {
    console.warn("Could not read system-prompt.md, using fallback:", error)
    cached = FALLBACK
  }
  return cached
}
