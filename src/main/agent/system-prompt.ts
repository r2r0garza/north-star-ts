import { app } from "electron"
import { readFile } from "fs/promises"
import path from "path"
import type { Mode } from "../db/types"

// Each agent mode's system prompt is composed at load time from two files in
// prompts/: a shared behavioral core (_core/behavior.md — refusals, tone,
// wellbeing, evenhandedness, prompt-secrecy) prepended to a per-mode delta
// (<mode>-system-prompt.md) that says only what's different about that mode. This
// keeps the safety/tone policy identical across modes and editable in one place,
// while each mode file stays small. `app.getAppPath()` resolves to the project
// root in dev and the app bundle when packaged (prompts/ ships via the
// build.files entry in package.json). Dynamic per-turn facts (git, model, cwd)
// are NOT here — they're a droppable context section (see context/sections.ts).
// Tools are NOT listed here either — the model receives each tool's full
// definition via the API `tools` array, the single source of truth.

// Maps a conversation mode to its per-mode delta file name.
const PROMPT_FILES: Record<Mode, string> = {
  chat: "chat-system-prompt.md",
  interactive: "interactive-system-prompt.md",
  north_star: "north-star-system-prompt.md",
}

// The shared behavioral core, prepended to every mode's delta.
const CORE_FILE = path.join("_core", "behavior.md")

// Fallback used only if a mode's delta file is missing or unreadable, so the
// agent still works rather than crashing.
const FALLBACK =
  "You are a helpful assistant. You may be given tools that run on the server; " +
  "rely on each tool's definition for what it does, use only the tools you've " +
  "been given, and don't claim capabilities you haven't."

// Cache the composed prompt per mode (each is loaded + composed from disk once).
const cache = new Map<Mode, string>()
// Cache the shared core once (shared across all modes). null = attempted and
// missing (fall back to delta-only); undefined = not yet attempted.
let coreCache: string | null | undefined

// Load the shared behavioral core once. Returns "" (not throwing) if it's missing
// so a mode prompt still composes to just its delta rather than failing the turn.
async function loadCore(): Promise<string> {
  if (coreCache !== undefined) return coreCache ?? ""
  try {
    const file = path.join(app.getAppPath(), "prompts", CORE_FILE)
    coreCache = (await readFile(file, "utf-8")).trim()
  } catch (error) {
    console.warn("Could not read shared prompt core, using delta only:", error)
    coreCache = null
  }
  return coreCache ?? ""
}

// Returns the composed system prompt for a mode: shared core + per-mode delta,
// loaded from disk once and cached. Defaults to "chat" if no mode is supplied.
export async function loadSystemPrompt(mode: Mode = "chat"): Promise<string> {
  const cached = cache.get(mode)
  if (cached !== undefined) return cached
  try {
    const core = await loadCore()
    const file = path.join(app.getAppPath(), "prompts", PROMPT_FILES[mode])
    const delta = (await readFile(file, "utf-8")).trim()
    // Compose: core first, then the mode delta. If the delta is empty, fall back
    // so the agent isn't left with only the core (which describes no mode).
    const prompt = delta ? (core ? `${core}\n\n${delta}` : delta) : FALLBACK
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
