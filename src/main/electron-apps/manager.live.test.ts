import { existsSync } from "fs"
import { mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, writeFile } from "fs/promises"
import { homedir, tmpdir } from "os"
import { join, resolve } from "path"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { LaunchError } from "./launch"
import { ElectronAppManager, type ElectronHandle } from "./manager"

// Launches real Electron fixture apps through the manager (plan 119 Phase B).
// Needs the repo's Electron binary and a display.
const electronPkg = resolve("node_modules/electron")
const canRun =
  existsSync(join(electronPkg, "path.txt")) &&
  (process.platform !== "linux" || !!process.env.DISPLAY)

const WINDOW_APP = `
const { app, BrowserWindow } = require("electron")
const { spawn } = require("child_process")
if (process.argv.includes("--print-env")) console.log("ENV_KEYS=" + Object.keys(process.env).sort().join(","))
if (process.argv.includes("--spawn-child")) {
  const child = spawn("sleep", ["60"], { stdio: "ignore" })
  console.log("CHILD_PID=" + child.pid)
}
app.whenReady().then(() => {
  if (process.argv.includes("--no-window")) return
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  w.loadURL("data:text/html,<title>Fixture</title><button>Go</button>")
  if (process.argv.includes("--crash-later")) setTimeout(() => process.exit(3), 800)
})
`

describe.skipIf(!canRun)("ElectronAppManager (live Electron)", () => {
  let ws: string
  let profileRoot: string
  let manager: ElectronAppManager
  const turn = new AbortController()

  beforeAll(async () => {
    ws = await realpath(await mkdtemp(join(tmpdir(), "electron-apps-ws-")))
    profileRoot = await realpath(await mkdtemp(join(tmpdir(), "electron-apps-profiles-")))
    await mkdir(join(ws, "app"))
    await mkdir(join(ws, "node_modules"))
    await symlink(electronPkg, join(ws, "node_modules/electron"), "dir")
    await writeFile(join(ws, "app/package.json"), JSON.stringify({ name: "fixture", main: "main.js" }))
    await writeFile(join(ws, "app/main.js"), WINDOW_APP)
  })

  afterEach(async () => {
    await manager?.shutdown()
  })

  afterAll(async () => {
    await rm(ws, { recursive: true, force: true })
    await rm(profileRoot, { recursive: true, force: true })
  })

  function handle(
    conversationId = "c1",
    options: Partial<ConstructorParameters<typeof ElectronAppManager>[0]> = {},
    signal = turn.signal
  ): ElectronHandle {
    manager ??= new ElectronAppManager({
      profileRoot: () => profileRoot,
      hostPackageName: () => "north-star",
      ...options,
    })
    return manager.handleForTurn(conversationId, ws, signal)
  }

  async function launch(h: ElectronHandle, input: Record<string, unknown>, invocationId?: string) {
    return h.launch(input, await h.prepare(input), invocationId)
  }

  it("launches, reports windows, closes and removes the profile", async () => {
    manager = undefined as never
    const h = handle()
    const status = await launch(h, { entry: "app" }, "inv-1")
    expect(status.state).toBe("ready")
    expect(status.isolation).toBe("electron-user-data-dir")
    expect(status.windows).toHaveLength(1)
    // status() refreshes titles on read.
    let windows = status.windows
    for (let i = 0; i < 50 && windows[0]?.title !== "Fixture"; i++) {
      await new Promise((r) => setTimeout(r, 100))
      windows = (await h.status())[0].windows
    }
    expect(windows[0]).toMatchObject({ title: "Fixture" })
    expect(await readdir(join(profileRoot, String(process.pid)))).toHaveLength(1)

    // A retried invocation reports the same session; no second app.
    expect(h.previous("inv-1")?.sessionId).toBe(status.sessionId)
    expect(await h.status()).toHaveLength(1)

    // Another conversation can neither see nor close it.
    const other = handle("c2")
    expect(await other.status(status.sessionId)).toEqual([])
    await expect(other.close(status.sessionId)).rejects.toThrow(LaunchError)

    const closed = await h.close(status.sessionId)
    expect(closed.state).toBe("exited")
    expect(closed.cleanup).toMatch(/profile removed/)
    expect(await readdir(join(profileRoot, String(process.pid)))).toEqual([])
    // Idempotent.
    expect((await h.close(status.sessionId)).state).toBe("exited")
  }, 60_000)

  it("refuses a launch whose inputs changed after approval", async () => {
    manager = undefined as never
    const h = handle()
    const approved = await h.prepare({ entry: "app", args: ["a"] })
    await expect(h.launch({ entry: "app", args: ["b"] }, approved, undefined)).rejects.toMatchObject({
      code: "approval_changed",
    })
    expect(await h.status()).toEqual([])
  })

  it("passes a minimal environment", async () => {
    manager = undefined as never
    process.env.NORTH_STAR_FAKE_PROVIDER_KEY = "secret"
    try {
      const h = handle()
      const status = await launch(h, { entry: "app", args: ["--print-env"] })
      const line = status.logTail.find((l) => l.includes("ENV_KEYS="))!
      expect(line).toBeDefined()
      expect(line).not.toMatch(/NORTH_STAR_FAKE_PROVIDER_KEY|NODE_OPTIONS/)
      expect(line).toMatch(/HOME/)
    } finally {
      delete process.env.NORTH_STAR_FAKE_PROVIDER_KEY
    }
  }, 60_000)

  it("stops the app's child processes on close", async () => {
    manager = undefined as never
    const h = handle()
    const status = await launch(h, { entry: "app", args: ["--spawn-child"] })
    const pid = Number(status.logTail.join("\n").match(/CHILD_PID=(\d+)/)?.[1])
    expect(pid).toBeGreaterThan(0)
    expect(() => process.kill(pid, 0)).not.toThrow()
    await h.close(status.sessionId)
    await new Promise((r) => setTimeout(r, 200))
    expect(() => process.kill(pid, 0)).toThrow()
  }, 60_000)

  it("reports a crash after ready and releases its profile", async () => {
    manager = undefined as never
    const h = handle()
    const status = await launch(h, { entry: "app", args: ["--crash-later"] })
    await new Promise((r) => setTimeout(r, 2_500))
    const [after] = await h.status(status.sessionId)
    expect(after.state).toBe("crashed")
    expect(after.exit?.code).toBe(3)
    expect(after.cleanup).toMatch(/profile removed/)
  }, 60_000)

  it("fails a launch with no window by the startup timeout", async () => {
    manager = undefined as never
    const h = handle()
    await expect(
      launch(h, { entry: "app", args: ["--no-window"], startup_timeout_ms: 2_000 })
    ).rejects.toMatchObject({ code: "launch_failed" })
    const [failed] = await h.status()
    expect(failed.state).toBe("failed")
    expect(failed.error).toMatch(/No app window/)
  }, 60_000)

  it("tears down a launch cancelled by Stop", async () => {
    manager = undefined as never
    const stop = new AbortController()
    const h = handle("c1", {}, stop.signal)
    const pending = launch(h, { entry: "app", args: ["--no-window"] })
    setTimeout(() => stop.abort(), 500)
    await expect(pending).rejects.toThrow()
    const [cancelled] = await h.status()
    expect(cancelled.state).toBe("failed")
    expect(cancelled.error).toBe("Launch cancelled.")
  }, 60_000)

  it("enforces the per-conversation limit", async () => {
    manager = undefined as never
    const h = handle("c1", { maxPerConversation: 1 })
    await launch(h, { entry: "app" })
    await expect(launch(h, { entry: "app" })).rejects.toMatchObject({ code: "session_limit" })
  }, 60_000)
})

// Opt-in (boots the full app): ELECTRON_APPS_NORTH_STAR=1 after `pnpm build`.
// Run vitest directly, not via `pnpm test`: with-node-sqlite.mjs rebuilds
// better-sqlite3 for Node, so the launched Electron app cannot open its DB.
describe.skipIf(
  !canRun ||
    !process.env.ELECTRON_APPS_NORTH_STAR ||
    !existsSync(resolve("out/main/index.js"))
)("ElectronAppManager (North Star test instance)", () => {
  it("launches this repo's build under --test-profile and closes it", async () => {
    const started = Date.now()
    const profileRoot = await realpath(await mkdtemp(join(tmpdir(), "electron-apps-ns-")))
    const manager = new ElectronAppManager({
      profileRoot: () => profileRoot,
      hostPackageName: () => "north-star",
    })
    try {
      const h = manager.handleForTurn("c1", resolve("."), new AbortController().signal)
      const approved = await h.prepare({ entry: "." })
      expect(approved.isolation).toBe("north-star-test-profile")
      const status = await h.launch({ entry: "." }, approved, undefined)
      expect(status.state).toBe("ready")
      let title = ""
      for (let i = 0; i < 100 && !title.includes("(Test instance)"); i++) {
        await new Promise((r) => setTimeout(r, 100))
        title = (await h.status())[0].windows[0]?.title ?? ""
      }
      expect(title).toMatch(/\(Test instance\)/)
      const [profile] = await readdir(join(profileRoot, String(process.pid)))
      expect(
        (await readdir(join(profileRoot, String(process.pid), profile, "user-data"))).some((f) =>
          f.endsWith(".db")
        )
      ).toBe(true)
      // Phase C on the real app: read it, act on it, see it.
      await h.wait(status.sessionId, { kind: "load" }, 20_000)
      // First run opens Settings (no provider configured) over the guide.
      await h.wait(status.sessionId, { kind: "text", text: "AI & Models" }, 20_000)
      const snap = (await h.snapshot(status.sessionId)).text
      expect(snap).toContain('dialog "Settings"')
      const close = snap.split("\n").find((l) => /\] button "Close"/.test(l))?.match(/\[(s\d+e\d+)\]/)?.[1]
      expect(close).toBeDefined()
      await h.interact(status.sessionId, { action: "click", ref: close! })
      await h.wait(status.sessionId, { kind: "text_gone", text: "AI & Models" }, 10_000)
      // The main UI is exposed; type into the composer (never sent).
      const main = (await h.snapshot(status.sessionId)).text
      const composer = main.split("\n").find((l) => l.includes('] textbox "Send a message'))?.match(/\[(s\d+e\d+)\]/)?.[1]
      expect(composer).toBeDefined()
      await h.interact(status.sessionId, { action: "fill", ref: composer!, text: "hello from the agent" })
      expect((await h.snapshot(status.sessionId)).text).toContain('value="hello from the agent"')
      // The same facts as a declarative check, run host-side in one call.
      const run = await h.run(status.sessionId, {
        name: "north star smoke",
        steps: [
          { step: "assert", that: { title: { contains: "(Test instance)" } } },
          { step: "assert", that: { state: { role: "textbox", nameContains: "Send a message" }, value: "hello from the agent" } },
          { step: "assert", that: { visible: { role: "button", name: "Settings" } } },
          { step: "assert", that: { hidden: { role: "dialog", name: "Settings" } } },
        ],
      }, { confirm: async () => true, onScreenshot: () => {} })
      expect(run.status).toBe("pass")
      const shot = await h.screenshot(status.sessionId)
      expect(Buffer.from(shot.jpegBase64, "base64").subarray(0, 2).toString("hex")).toBe("ffd8")
      const closed = await h.close(status.sessionId)
      expect(closed.state).toBe("exited")
      expect(closed.exit?.code).toBe(0)
      expect(closed.cleanup).toMatch(/profile removed/)

      // Full quit and relaunch: a fresh disposable profile again shows the
      // first-run Settings dialog, so nothing persisted from the first run.
      const again = await h.launch({ entry: "." }, await h.prepare({ entry: "." }), undefined)
      await h.wait(again.sessionId, { kind: "text", text: "AI & Models" }, 20_000)
      expect((await h.snapshot(again.sessionId)).text).toContain('dialog "Settings"')
      expect((await h.close(again.sessionId)).exit?.code).toBe(0)

      // Neither run modified the personal profile (a concurrently running
      // controller instance writing its own files would also show up here).
      expect(await modifiedSince(started, personalDirs())).toEqual([])
    } finally {
      await manager.shutdown()
      await rm(profileRoot, { recursive: true, force: true })
    }
  }, 120_000)
})

function personalDirs(): string[] {
  const home = homedir()
  return [
    join(home, "Library/Application Support/north-star"),
    join(home, ".config/north-star"),
    ...[".north-star", ".cowork", ".processes"].map((d) => join(home, d)),
  ].filter(existsSync)
}

async function modifiedSince(since: number, dirs: string[]): Promise<string[]> {
  const touched: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = join(dir, entry.name)
      if (entry.isDirectory() && depth < 3) await walk(full, depth + 1)
      else if (entry.isFile() && (await stat(full)).mtimeMs > since) touched.push(full)
    }
  }
  for (const dir of dirs) await walk(dir, 0)
  return touched
}
