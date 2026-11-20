import { describe, expect, it, vi } from "vitest"

vi.mock("electron", () => ({ app: {}, dialog: {} }))
const { isNewer, pickAsset } = await import("./updater")

const asset = (name: string) => ({ name, browser_download_url: name })

describe("updater", () => {
  it("compares versions numerically", () => {
    expect(isNewer("v0.1.10", "0.1.2")).toBe(true)
    expect(isNewer("v0.2.0", "0.1.9")).toBe(true)
    expect(isNewer("v0.1.2", "0.1.2")).toBe(false)
    expect(isNewer("v0.1.1", "0.1.2")).toBe(false)
  })

  it("picks the asset for this platform and arch", () => {
    const assets = [
      asset("North.Star-0.2.0-arm64.dmg"),
      asset("North.Star-0.2.0.dmg"),
      asset("North.Star.Setup.0.2.0.exe"),
      asset("North.Star.Setup.0.2.0.exe.blockmap"),
    ]
    expect(pickAsset(assets, "darwin", "arm64")?.name).toBe("North.Star-0.2.0-arm64.dmg")
    expect(pickAsset(assets, "darwin", "x64")?.name).toBe("North.Star-0.2.0.dmg")
    expect(pickAsset(assets, "win32", "x64")?.name).toBe("North.Star.Setup.0.2.0.exe")
    expect(pickAsset(assets, "linux", "x64")).toBeUndefined()
  })
})
