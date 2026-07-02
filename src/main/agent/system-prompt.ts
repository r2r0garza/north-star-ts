import { app } from "electron"
import { readFile } from "fs/promises"
import path from "path"
import type { Mode } from "../db/types"

// Each agent mode has its own base system prompt in prompts/<mode>-system-prompt.md
// so prompts can be edited without touching code. `app.getAppPath()` resolves to
// the project root in dev and the app bundle when packaged (the prompts/ dir is
// shipped via the build.files entry in package.json). The skills section is
// appended elsewhere. Tools are NOT listed here — the model receives each tool's
// full definition via the API `tools` array, which is the single source of truth.

// Maps a conversation mode to its prompt file name.
const PROMPT_FILES: Record<Mode, string> = {
  chat: "chat-system-prompt.md",
  interactive: "interactive-system-prompt.md",
  north_star: "north-star-system-prompt.md",
}

// Fallback used only if a mode's file is missing or unreadable, so the agent
// still works rather than crashing.
const FALLBACK =
  "You are a helpful assistant. You may be given tools that run on the server; " +
  "rely on each tool's definition for what it does, use only the tools you've " +
  "been given, and don't claim capabilities you haven't."

// Cache loaded prompts per mode (loaded from disk once each).
const cache = new Map<Mode, string>()

// Returns the base system prompt for a mode, loading it from disk once and
// caching it. Defaults to "chat" if no mode is supplied.
export async function loadSystemPrompt(mode: Mode = "chat"): Promise<string> {
  const cached = cache.get(mode)
  if (cached !== undefined) return cached
  try {
    const file = path.join(app.getAppPath(), "prompts", PROMPT_FILES[mode])
    const text = (await readFile(file, "utf-8")).trim()
    const prompt = text || FALLBACK
    cache.set(mode, prompt)
    return prompt
  } catch (error) {
    console.warn(
      `Could not read prompt for mode "${mode}", using fallback:`,
      error
    )
    cache.set(mode, FALLBACK)
    return FALLBACK
  }
}
