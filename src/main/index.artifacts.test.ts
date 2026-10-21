import { readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
const registration = source.slice(
  source.indexOf('ipcMain.handle(\n  "artifacts:read"'),
  source.indexOf('ipcMain.handle(\n  "media:read-message"')
)
function setup() {
  const contents = { mainFrame: {} }
  const read = vi.fn().mockReturnValue({ artifact: {} })
  let handler!: (...args: unknown[]) => unknown
  const javascript = registration
    .replace(/: unknown/g, "")
    .replace(/ as string/g, "")
  new Function("ipcMain", "mainWindow", "readConversationArtifact", javascript)(
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
describe("scoped artifact read IPC", () => {
  it("passes conversation, artifact and exact revision to the repository", () => {
    const { read, handler, event } = setup()
    handler(event, "conversation", "artifact", 1)
    expect(read).toHaveBeenCalledWith("conversation", "artifact", 1)
  })
  it("rejects foreign senders, subframes and invalid references", () => {
    const { read, handler, event } = setup()
    for (const args of [
      [{ ...event, sender: {} }, "conversation", "artifact", 1],
      [{ ...event, senderFrame: {} }, "conversation", "artifact", 1],
      [event, "conversation", "../secret", 1],
      [event, null, "artifact", 1],
      [event, "conversation", "artifact", 0],
      [event, "conversation", "artifact", 1.5],
      [event, "conversation", "artifact", "1"],
      [event, "conversation", "artifact", Infinity],
    ])
      expect(handler(...args)).toEqual({ error: "Artifact unavailable." })
    expect(read).not.toHaveBeenCalled()
  })
})
