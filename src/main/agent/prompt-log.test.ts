import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"

const electron = vi.hoisted(() => ({ root: "", isPackaged: false }))
vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return electron.isPackaged
    },
    getAppPath: () => path.join(electron.root, "app"),
    getPath: () => path.join(electron.root, "userData"),
  },
}))

import { logRequestMessages, promptLogDir } from "./prompt-log"

beforeEach(() => {
  electron.root = mkdtempSync(path.join(tmpdir(), "prompt-log-"))
  electron.isPackaged = false
})
afterEach(() => rmSync(electron.root, { recursive: true, force: true }))

describe("logRequestMessages", () => {
  it("writes the round's messages in order with image data omitted", async () => {
    const messages: unknown[] = [
      { role: "system", content: "persona" },
      { role: "tool", tool_call_id: "c1", content: "Screenshot captured" },
      {
        role: "user",
        content: [
          { type: "text", text: "Image 1" },
          {
            type: "image_url",
            image_url: { url: "data:image/jpeg;base64,AAAA" },
          },
        ],
      },
    ]
    const file = await logRequestMessages({
      mode: "chat",
      turnStartedAt: new Date(2026, 9, 12, 9, 5, 7),
      round: 3,
      model: "gpt-x",
      messages,
      toolNames: ["browser_screenshot"],
    })
    // Mutating after the call must not change the snapshot.
    messages.push({ role: "assistant", content: "later" })

    expect(path.basename(file!)).toBe(
      "chat - 10-12-2026 09-05-07 - round 3.json"
    )
    const logged = JSON.parse(readFileSync(file!, "utf-8"))
    expect(logged.round).toBe(3)
    expect(logged.tools).toEqual(["browser_screenshot"])
    expect(logged.messages.map((m: { role: string }) => m.role)).toEqual([
      "system",
      "tool",
      "user",
    ])
    expect(logged.messages[2].content[1].image_url.url).toBe(
      "data:image/jpeg;base64,<4 chars omitted>"
    )
  })

  it("logs under userData in a packaged build", () => {
    expect(promptLogDir()).toBe(
      path.join(electron.root, "app", "system-prompt-logs")
    )
    electron.isPackaged = true
    expect(promptLogDir()).toBe(
      path.join(electron.root, "userData", "system-prompt-logs")
    )
  })
})
