import { afterEach, describe, expect, it, vi } from "vitest"
import { decodeImage, inspectImage } from "./image_decoder"

const state = vi.hoisted(() => ({
  windows: [] as any[],
  result: undefined as any,
  load: undefined as any,
}))
vi.mock("electron", () => ({
  BrowserWindow: class {
    destroyed = false
    webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      executeJavaScript: vi.fn(async () => state.result),
    }
    constructor(public options: unknown) {
      state.windows.push(this)
    }
    loadURL = vi.fn(() => state.load ?? Promise.resolve())
    isDestroyed() {
      return this.destroyed
    }
    destroy() {
      this.destroyed = true
    }
  },
}))
function png(width = 2, height = 3) {
  const data = Buffer.alloc(33)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data)
  data.write("IHDR", 12)
  data.writeUInt32BE(width, 16)
  data.writeUInt32BE(height, 20)
  return data
}
afterEach(() => {
  state.windows = []
  state.result = undefined
  state.load = undefined
  vi.useRealTimers()
})

describe("standalone image decoder", () => {
  it("recognizes PNG, GIF, JPEG and all three WebP dimension headers", () => {
    expect(inspectImage(png())).toEqual({ format: "png", width: 2, height: 3 })
    const gif = Buffer.alloc(10)
    gif.write("GIF89a")
    gif.writeUInt16LE(2, 6)
    gif.writeUInt16LE(3, 8)
    expect(inspectImage(gif)).toEqual({ format: "gif", width: 2, height: 3 })
    const jpeg = Buffer.from([255, 216, 255, 194, 0, 8, 8, 0, 3, 0, 2, 3])
    expect(inspectImage(jpeg)).toEqual({ format: "jpeg", width: 2, height: 3 })
    for (const chunk of ["VP8X", "VP8 ", "VP8L"]) {
      const webp = Buffer.alloc(30)
      webp.write("RIFF")
      webp.write("WEBP", 8)
      webp.write(chunk, 12)
      if (chunk === "VP8X") {
        webp.writeUIntLE(1, 24, 3)
        webp.writeUIntLE(2, 27, 3)
      }
      if (chunk === "VP8 ") {
        Buffer.from([157, 1, 42]).copy(webp, 23)
        webp.writeUInt16LE(2, 26)
        webp.writeUInt16LE(3, 28)
      }
      if (chunk === "VP8L") {
        webp[20] = 47
        webp.writeUInt32LE(1 | (2 << 14), 21)
      }
      expect(inspectImage(webp)).toEqual({
        format: "webp",
        width: 2,
        height: 3,
      })
    }
  })
  it("rejects malformed, oversized, zero-dimension and decompression-bomb headers before creating a renderer", async () => {
    for (const bytes of [
      Buffer.from("<svg/>"),
      Buffer.alloc(17 * 1024 * 1024),
      png(0),
      png(16385),
      png(8192, 8192),
    ]) {
      await expect(decodeImage(bytes)).rejects.toThrow()
    }
    expect(state.windows).toHaveLength(0)
  })
  it("uses a sandbox, offline CSP, first-frame bitmap decoding and orientation; destroys the renderer", async () => {
    state.result = {
      jpegBase64: Buffer.from([255, 216, 255, 217]).toString("base64"),
      width: 2,
      height: 3,
    }
    await expect(decodeImage(png())).resolves.toEqual(state.result)
    const window = state.windows[0]
    expect(window.options.webPreferences).toMatchObject({
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
    })
    expect(decodeURIComponent(window.loadURL.mock.calls[0][0])).toContain(
      "connect-src 'none'"
    )
    const script = window.webContents.executeJavaScript.mock.calls[0][0]
    expect(script).toContain("createImageBitmap")
    expect(script).toContain("imageOrientation: 'from-image'")
    expect(window.destroyed).toBe(true)
  })
  it("cancels stuck decoding and ignores late work", async () => {
    state.load = new Promise(() => {})
    const controller = new AbortController()
    const pending = decodeImage(png(), controller.signal)
    await vi.waitFor(() => expect(state.windows).toHaveLength(1))
    controller.abort()
    await expect(pending).rejects.toThrow("canceled")
    expect(state.windows[0].destroyed).toBe(true)
    expect(
      state.windows[0].webContents.executeJavaScript
    ).not.toHaveBeenCalled()
  })
  it("times out a hung renderer and bounds encoded output", async () => {
    vi.useFakeTimers()
    state.load = new Promise(() => {})
    const pending = decodeImage(png())
    const rejected = expect(pending).rejects.toThrow("timed out")
    await vi.advanceTimersByTimeAsync(15001)
    await rejected
    expect(state.windows[0].destroyed).toBe(true)
    state.load = undefined
    state.result = {
      jpegBase64: "a".repeat(3 * 1024 * 1024),
      width: 2,
      height: 3,
    }
    await expect(decodeImage(png())).rejects.toThrow("oversized")
    expect(state.windows[1].destroyed).toBe(true)
  })
  it("does not start a canceled operation", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(decodeImage(png(), controller.signal)).rejects.toThrow(
      "canceled"
    )
    expect(state.windows).toHaveLength(0)
  })
})
