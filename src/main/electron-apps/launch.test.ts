import { mkdtemp, mkdir, rm, writeFile, realpath } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  LaunchError,
  launchIdentity,
  resolveLaunch,
  validateArgs,
  validateStartupTimeout,
} from "./launch"

const code = async (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e) => (e instanceof LaunchError ? e.code : String(e))
  )

describe("validateArgs", () => {
  it("accepts plain app args", () => {
    expect(validateArgs(["--mode=test", "file.txt"])).toEqual([
      "--mode=test",
      "file.txt",
    ])
  })

  it.each([
    "--remote-debugging-port=9222",
    "--inspect",
    "--inspect-brk=0",
    "--user-data-dir=/tmp/x",
    "--test-profile=/tmp/x",
    "--no-sandbox",
    "--disable-web-security",
    "--js-flags=--expose-gc",
  ])("rejects host-owned or unsafe flag %s", (flag) => {
    expect(() => validateArgs([flag])).toThrow(LaunchError)
  })

  it("bounds count, length and type", () => {
    expect(() => validateArgs("--x")).toThrow(/array/)
    expect(() => validateArgs(Array(33).fill("a"))).toThrow(/At most/)
    expect(() => validateArgs(["a".repeat(1025)])).toThrow(/too long/)
  })

  it("bounds the startup timeout", () => {
    expect(validateStartupTimeout(undefined)).toBe(30_000)
    expect(() => validateStartupTimeout(500)).toThrow(LaunchError)
    expect(() => validateStartupTimeout(1.5e3 + 0.5)).toThrow(LaunchError)
  })
})

describe("resolveLaunch", () => {
  let ws: string
  beforeEach(async () => {
    ws = await realpath(await mkdtemp(join(tmpdir(), "electron-launch-")))
    await mkdir(join(ws, "app"))
    await writeFile(
      join(ws, "app/package.json"),
      JSON.stringify({ name: "fixture", main: "main.js" })
    )
    await writeFile(join(ws, "app/main.js"), "")
    await mkdir(join(ws, "node_modules/electron/dist"), { recursive: true })
    await writeFile(join(ws, "node_modules/electron/path.txt"), "electron-bin")
    await writeFile(join(ws, "node_modules/electron/dist/electron-bin"), "")
  })
  afterEach(() => rm(ws, { recursive: true, force: true }))

  it("resolves the workspace Electron and generic isolation", async () => {
    const d = await resolveLaunch(ws, { entry: "app", args: ["x"] }, "north-star")
    expect(d).toMatchObject({
      executable: join(ws, "node_modules/electron/dist/electron-bin"),
      entry: join(ws, "app"),
      cwd: ws,
      args: ["x"],
      isolation: "electron-user-data-dir",
    })
  })

  it("uses the test-profile contract for the host's own package", async () => {
    const d = await resolveLaunch(ws, { entry: "app" }, "fixture")
    expect(d.isolation).toBe("north-star-test-profile")
  })

  it("binds the identity to args", async () => {
    const a = await resolveLaunch(ws, { entry: "app", args: ["a"] }, null)
    const b = await resolveLaunch(ws, { entry: "app", args: ["b"] }, null)
    expect(launchIdentity(a)).not.toBe(launchIdentity(b))
  })

  it("refuses escapes, packaged apps, missing builds and missing Electron", async () => {
    expect(await code(resolveLaunch(ws, { entry: "../x" }, null))).toBe("bad_path")
    expect(await code(resolveLaunch(ws, { entry: "/Applications/Slack.app" }, null))).toBe(
      "unsupported_packaged"
    )
    expect(await code(resolveLaunch(ws, { entry: "app", cwd: "/" }, null))).toBe("bad_path")
    await rm(join(ws, "app/main.js"))
    expect(await code(resolveLaunch(ws, { entry: "app" }, null))).toBe("missing_build")
    await writeFile(join(ws, "app/main.js"), "")
    await rm(join(ws, "node_modules"), { recursive: true })
    expect(await code(resolveLaunch(ws, { entry: "app" }, null))).toBe(
      "electron_missing"
    )
  })
})
