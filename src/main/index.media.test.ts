import { readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"

// Exercise the registration without booting Electron or the application services.
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
const registration = source.slice(
  source.indexOf('ipcMain.handle(\n  "media:read-message"'),
  source.indexOf('ipcMain.handle("chat",')
)
function setup() {
  const contents = { mainFrame: {} }
  const read = vi
    .fn()
    .mockResolvedValue({ dataUrl: "data:image/jpeg;base64,YWJj" })
  let handler!: (...args: unknown[]) => Promise<unknown>
  // Strip only TypeScript annotations in this isolated handler.
  const javascript = registration
    .replace(/: unknown/g, "")
    .replace(/ as string/g, "")
  new Function("ipcMain", "mainWindow", "readMessageMedia", javascript)(
    {
      handle: (_channel: string, callback: typeof handler) => {
        handler = callback
      },
    },
    { webContents: contents },
    read
  )
  return {
    read,
    handler,
    event: { sender: contents, senderFrame: contents.mainFrame },
  }
}
describe("scoped stored media IPC", () => {
  it("passes the complete scoped identity to the backend", async () => {
    const { read, handler, event } = setup()
    await handler(event, "conversation", "message", "media")
    expect(read).toHaveBeenCalledWith("conversation", "message", "media")
  })
  it("rejects other senders, subframes, paths and malformed identifiers before reading", async () => {
    const { read, handler, event } = setup()
    for (const args of [
      [{ ...event, sender: {} }, "conversation", "message", "media"],
      [{ ...event, senderFrame: {} }, "conversation", "message", "media"],
      [event, "conversation", "message", "../secret"],
      [event, "conversation", "message", "https://example.com/image"],
      [event, null, "message", "media"],
      [event, "x".repeat(129), "message", "media"],
    ])
      expect(await handler(...args)).toEqual({ error: "Image unavailable." })
    expect(read).not.toHaveBeenCalled()
  })
  it("does not expose backend exception details", async () => {
    const { read, handler, event } = setup()
    read.mockRejectedValue(new Error("/private/blob/path"))
    expect(await handler(event, "conversation", "message", "media")).toEqual({
      error: "Image unavailable.",
    })
  })
})
