import { describe, it, expect, beforeEach, vi } from "vitest"

// loadSystemPrompt reads prompts/<mode> + prompts/_core/behavior.md from disk via
// app.getAppPath() + fs/promises. Mock both so the composition logic is tested in
// isolation. `files` maps a path suffix → contents; a missing entry throws ENOENT
// so the fallback paths are exercised.
vi.mock("electron", () => ({ app: { getAppPath: () => "/app" } }))

let files: Record<string, string> = {}
vi.mock("fs/promises", () => ({
  readFile: (p: string) => {
    const hit = Object.keys(files).find((suffix) => p.endsWith(suffix))
    if (hit) return Promise.resolve(files[hit])
    return Promise.reject(new Error(`ENOENT: ${p}`))
  },
}))

import { loadSystemPrompt } from "./system-prompt"

// The module caches per mode and caches the core once. Re-import fresh each test
// so caches don't bleed across cases.
async function freshLoad() {
  vi.resetModules()
  const mod = await import("./system-prompt")
  return mod.loadSystemPrompt
}

describe("loadSystemPrompt", () => {
  beforeEach(() => {
    files = {}
  })

  it("composes shared core + mode delta (core first)", async () => {
    files = {
      "_core/behavior.md": "CORE POLICY",
      "chat-system-prompt.md": "CHAT DELTA",
    }
    const load = await freshLoad()
    const prompt = await load("chat")
    expect(prompt).toBe("CORE POLICY\n\nCHAT DELTA")
    expect(prompt.indexOf("CORE")).toBeLessThan(prompt.indexOf("CHAT"))
  })

  it("selects the delta file matching the mode", async () => {
    files = {
      "_core/behavior.md": "CORE",
      "north-star-system-prompt.md": "NS DELTA",
    }
    const load = await freshLoad()
    expect(await load("north_star")).toContain("NS DELTA")
  })

  it("falls back to delta-only when the core is missing", async () => {
    files = { "interactive-system-prompt.md": "INT DELTA" }
    const load = await freshLoad()
    expect(await load("interactive")).toBe("INT DELTA")
  })

  it("uses the fallback when the mode delta is missing", async () => {
    files = { "_core/behavior.md": "CORE" }
    const load = await freshLoad()
    const prompt = await load("chat")
    expect(prompt).toContain("helpful assistant")
    expect(prompt).not.toContain("CORE")
  })

  it("defaults to chat when no mode is given", async () => {
    files = {
      "_core/behavior.md": "CORE",
      "chat-system-prompt.md": "CHAT DELTA",
    }
    const load = await freshLoad()
    expect(await load()).toContain("CHAT DELTA")
  })
})
