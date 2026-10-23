import { existsSync } from "fs"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join, resolve } from "path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ElectronAppManager, type ElectronHandle } from "./manager"

// Phase C qualification against a real multi-window Electron fixture: every
// interaction goes through CDP Input (or the reported native-select path) and
// is observed through host-polled waits, never page script from the test.
const electronPkg = resolve("node_modules/electron")
const canRun =
  existsSync(join(electronPkg, "path.txt")) &&
  (process.platform !== "linux" || !!process.env.DISPLAY)

const MAIN = `
const { app, BrowserWindow } = require("electron")
const path = require("path")
app.whenReady().then(() => {
  const w = new BrowserWindow({ width: 900, height: 700, show: false, webPreferences: { sandbox: true, contextIsolation: true } })
  w.webContents.setWindowOpenHandler(() => ({ action: "allow", overrideBrowserWindowOptions: { show: false } }))
  w.loadFile(path.join(__dirname, "index.html"))
})
`
const INDEX = `<!doctype html><html><head><title>Fixture</title>
<style>#tall{height:3000px} #modal{display:none} #modal.open{display:block} #src,#dst{width:80px;height:40px;border:1px solid}</style></head>
<body>
<h1>Fixture home</h1>
<button id="count">Count</button><p id="out">Clicked 0</p>
<input aria-label="Name" id="nameField"><p id="hello"></p>
<label>Color <select id="color"><option value="red">Red</option><option value="green">Green</option></select></label><p id="colorOut"></p>
<span id="tipTarget" tabindex="0" role="note" aria-label="Hover me">Hover me</span><p id="tip"></p>
<button id="openDialog">Open dialog</button><p id="dialogState"></p>
<div id="modal" role="dialog" aria-label="Modal"><button>Inside</button></div>
<div id="src" role="button" aria-label="Drag source">src</div><div id="dst" role="region" aria-label="Drop zone">dst</div><p id="dropped"></p>
<button id="popup">Open window</button>
<a href="page2.html">Next page</a>
<p id="scrolled"></p>
<div id="tall"></div>
<script>
let n = 0
count.addEventListener("click", (e) => { if (e.isTrusted) out.textContent = "Clicked " + (++n) })
nameField.addEventListener("input", () => { hello.textContent = "Hello " + nameField.value })
color.addEventListener("change", () => { colorOut.textContent = "Color: " + color.value })
tipTarget.addEventListener("mouseover", () => { tip.textContent = "Tip shown" })
openDialog.addEventListener("click", () => { modal.classList.add("open"); modal.querySelector("button").focus() })
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && modal.classList.contains("open")) { modal.classList.remove("open"); dialogState.textContent = "Dialog closed" } })
let dragging = false
src.addEventListener("mousedown", () => { dragging = true })
document.addEventListener("mouseup", (e) => { if (dragging && dst.contains(document.elementFromPoint(e.clientX, e.clientY))) dropped.textContent = "Dropped" ; dragging = false })
popup.addEventListener("click", () => window.open("popup.html", "_blank"))
addEventListener("scroll", () => { scrolled.textContent = "Scrolled" })
</script></body></html>`
const PAGE2 = `<!doctype html><title>Page two</title><h1>Page two</h1><button>Back home</button>`
const POPUP = `<!doctype html><title>Popup</title><h1>Popup window</h1><button>Popup action</button>`

function ref(snapshot: string, role: string, name: string): string {
  const line = snapshot.split("\n").find((l) => l.includes(`] ${role} "${name}"`))
  const match = line?.match(/\[(s\d+e\d+)\]/)
  if (!match) throw new Error(`no ref for ${role} "${name}" in:\n${snapshot}`)
  return match[1]
}

describe.skipIf(!canRun)("WindowControl (live Electron fixture)", () => {
  let ws: string
  let profileRoot: string
  let manager: ElectronAppManager
  let h: ElectronHandle
  let sessionId: string

  beforeAll(async () => {
    ws = await realpath(await mkdtemp(join(tmpdir(), "electron-control-ws-")))
    profileRoot = await realpath(await mkdtemp(join(tmpdir(), "electron-control-profiles-")))
    await mkdir(join(ws, "app"))
    await mkdir(join(ws, "node_modules"))
    await symlink(electronPkg, join(ws, "node_modules/electron"), "dir")
    await writeFile(join(ws, "app/package.json"), JSON.stringify({ name: "fixture", main: "main.js" }))
    await writeFile(join(ws, "app/main.js"), MAIN)
    await writeFile(join(ws, "app/index.html"), INDEX)
    await writeFile(join(ws, "app/page2.html"), PAGE2)
    await writeFile(join(ws, "app/popup.html"), POPUP)
    manager = new ElectronAppManager({ profileRoot: () => profileRoot, hostPackageName: () => null })
    h = manager.handleForTurn("c1", ws, new AbortController().signal)
    const status = await h.launch({ entry: "app" }, await h.prepare({ entry: "app" }), undefined)
    sessionId = status.sessionId
    await h.wait(sessionId, { kind: "load" }, 10_000)
  }, 60_000)

  afterAll(async () => {
    await manager?.shutdown()
    await rm(ws, { recursive: true, force: true })
    await rm(profileRoot, { recursive: true, force: true })
  })

  it("drives the fixture with real input and observes the results", async () => {
    const started = Date.now()
    let snap = (await h.snapshot(sessionId)).text
    expect(snap).toContain('heading "Fixture home"')

    await h.interact(sessionId, { action: "click", ref: ref(snap, "button", "Count") })
    // isTrusted-only handler: proves real input, not element.click().
    await h.wait(sessionId, { kind: "text", text: "Clicked 1" }, 5_000)

    await h.interact(sessionId, { action: "fill", ref: ref(snap, "textbox", "Name"), text: "Bob" })
    await h.wait(sessionId, { kind: "text", text: "Hello Bob" }, 5_000)
    await h.interact(sessionId, { action: "fill", ref: ref(snap, "textbox", "Name"), text: "" })
    const typed = await h.interact(sessionId, { action: "type", ref: ref(snap, "textbox", "Name"), text: "Ada" })
    expect(typed.inputMethod).toBe("cdp-key-events")
    await h.wait(sessionId, { kind: "text", text: "Hello Ada" }, 5_000)

    const selected = await h.interact(sessionId, { action: "select", ref: ref(snap, "combobox", "Color"), option: "Green" })
    expect(selected).toMatchObject({ inputMethod: "dom-assisted-native-select", detail: { value: "green" } })
    await h.wait(sessionId, { kind: "text", text: "Color: green" }, 5_000)

    await h.interact(sessionId, { action: "hover", ref: ref(snap, "note", "Hover me") })
    await h.wait(sessionId, { kind: "text", text: "Tip shown" }, 5_000)

    await h.interact(sessionId, { action: "drag", ref: ref(snap, "button", "Drag source"), toRef: ref(snap, "region", "Drop zone") })
    await h.wait(sessionId, { kind: "text", text: "Dropped" }, 5_000)

    await h.interact(sessionId, { action: "click", ref: ref(snap, "button", "Open dialog") })
    await h.wait(sessionId, { kind: "text", text: "Inside" }, 5_000)
    await h.interact(sessionId, { action: "press", key: "Escape" })
    await h.wait(sessionId, { kind: "text", text: "Dialog closed" }, 5_000)
    await h.wait(sessionId, { kind: "text_gone", text: "Inside" }, 5_000)

    await h.interact(sessionId, { action: "scroll", deltaY: 800 })
    await h.wait(sessionId, { kind: "text", text: "Scrolled" }, 5_000)
    console.log(`fixture sequence (13 steps) took ${Date.now() - started} ms`)

    const shot = await h.screenshot(sessionId)
    const jpeg = Buffer.from(shot.jpegBase64, "base64")
    expect(jpeg.subarray(0, 2).toString("hex")).toBe("ffd8")
    expect(Math.max(shot.width, shot.height)).toBeLessThanOrEqual(1280)

    // A ref from an older snapshot is refused.
    const oldRef = ref(snap, "button", "Count")
    snap = (await h.snapshot(sessionId)).text
    await expect(h.interact(sessionId, { action: "click", ref: oldRef })).rejects.toMatchObject({ code: "stale_ref" })
  }, 90_000)

  it("requires explicit selection among several windows", async () => {
    const snap = (await h.snapshot(sessionId)).text
    await h.interact(sessionId, { action: "click", ref: ref(snap, "button", "Open window") })
    await h.wait(sessionId, { kind: "window_count", atLeast: 2 }, 10_000)
    const [status] = await h.status(sessionId)
    const popup = status.windows.find((w) => w.url.endsWith("popup.html"))!
    const main = status.windows.find((w) => w.url.endsWith("index.html"))!
    expect(popup).toBeDefined()

    await h.selectWindow(sessionId, popup.windowId)
    await h.wait(sessionId, { kind: "title", contains: "Popup" }, 5_000)
    expect((await h.snapshot(sessionId)).text).toContain('heading "Popup window"')
    await h.selectWindow(sessionId, main.windowId)
    expect((await h.snapshot(sessionId)).text).toContain('heading "Fixture home"')
    await expect(h.selectWindow(sessionId, "not-a-window")).rejects.toMatchObject({ code: "unknown_window" })
  }, 60_000)

  it("runs a ~20-step declarative check host-side", async () => {
    const shots: string[] = []
    const result = await h.run(sessionId, {
      name: "fixture smoke",
      steps: [
        { step: "window", url: "index.html" },
        { step: "assert", that: { load: true } },
        { step: "assert", that: { pageText: { contains: "Clicked 1" } } },
        { step: "click", target: { role: "button", name: "Count" } },
        { step: "assert", that: { pageText: { contains: "Clicked 2" } } },
        { step: "fill", target: { label: "Name" }, text: "Zed" },
        { step: "assert", that: { pageText: { contains: "Hello Zed" } } },
        { step: "assert", that: { state: { label: "Name" }, value: "Zed" } },
        { step: "select", target: { role: "combobox", name: "Color" }, option: "Red" },
        { step: "assert", that: { pageText: { contains: "Color: red" } } },
        { step: "click", target: { role: "button", name: "Open dialog" } },
        { step: "assert", that: { visible: { role: "button", name: "Inside" } } },
        { step: "assert", that: { focused: { role: "button", name: "Inside" } } },
        { step: "press", key: "Escape" },
        { step: "assert", that: { hidden: { role: "button", name: "Inside" } } },
        { step: "hover", target: { role: "note", name: "Hover me" } },
        { step: "assert", that: { count: { role: "button", name: "Count" }, equals: 1 } },
        { step: "assert", that: { enabled: { role: "button", name: "Count" } } },
        { step: "assert", that: { title: { contains: "Fixture" } } },
        { step: "scroll", deltaY: 200 },
        { step: "screenshot" },
      ],
    }, { confirm: async () => true, onScreenshot: (s) => shots.push(s.label) })
    console.log(`check "fixture smoke" (21 steps) ran in ${result.totalMs} ms`)
    expect(result.status).toBe("pass")
    expect(result.steps.every((s) => s.status === "pass")).toBe(true)
    expect(result.steps[3].inputMethod).toBe("cdp-input")
    expect(shots).toEqual(["step 21"])
    expect(result.totalMs).toBeLessThan(10_000)
  }, 60_000)

  it("stops at the first failure with evidence", async () => {
    const shots: string[] = []
    const result = await h.run(sessionId, {
      steps: [
        { step: "click", target: { role: "button", name: "Count" } },
        { step: "assert", that: { pageText: { contains: "Clicked 999" } }, timeoutMs: 300 },
        { step: "click", target: { role: "button", name: "Count" } },
      ],
    }, { confirm: async () => true, onScreenshot: (s) => shots.push(s.label) })
    expect(result.status).toBe("fail")
    expect(result.failure).toMatchObject({ index: 1, screenshot: true })
    expect(result.failure!.error).toMatch(/not on the page/)
    expect(result.failure!.snapshotExcerpt).toContain('button "Count"')
    expect(result.steps.map((s) => s.status)).toEqual(["pass", "fail", "not_run"])
    expect(shots).toEqual(["failure at step 2"])
  }, 60_000)

  it("fails ambiguous locators and denied steps without acting", async () => {
    const ambiguous = await h.run(sessionId, { stepTimeoutMs: 300, steps: [{ step: "click", target: { role: "button" } }] }, { confirm: async () => true, onScreenshot: () => {} })
    expect(ambiguous.failure!.error).toMatch(/ambiguous \(\d+ matches\)/)
    const denied = await h.run(sessionId, {
      steps: [
        { step: "click", target: { role: "button", name: "Count" } },
        { step: "assert", that: { pageText: { contains: "Clicked 4" } } },
      ],
    }, { confirm: async () => false, onScreenshot: () => {} })
    expect(denied.failure).toMatchObject({ index: 0, error: "approval for this step was denied" })
    // The denied click never happened: the counter is still at 3.
    const still = await h.run(sessionId, { steps: [{ step: "assert", that: { pageText: { contains: "Clicked 3" } } }] }, { confirm: async () => true, onScreenshot: () => {} })
    expect(still.status).toBe("pass")
  }, 60_000)

  it("is cancelled mid-run by Stop", async () => {
    const stop = new AbortController()
    const handle = manager.handleForTurn("c1", ws, stop.signal)
    setTimeout(() => stop.abort(), 300)
    const result = await handle.run(sessionId, {
      steps: [{ step: "wait", until: { pageText: { contains: "never appears" } }, timeoutMs: 10_000 }, { step: "snapshot" }],
    }, { confirm: async () => true, onScreenshot: () => {} })
    expect(result.status).toBe("cancelled")
    expect(result.steps.map((s) => s.status)).toEqual(["fail", "not_run"])
  }, 60_000)

  it("invalidates refs and approvals on navigation", async () => {
    const snap = (await h.snapshot(sessionId)).text
    const link = ref(snap, "link", "Next page")
    const approved = await h.describe(sessionId, link)
    const result = await h.interact(sessionId, { action: "click", ref: link }, [approved])
    await h.wait(sessionId, { kind: "text", text: "Page two" }, 5_000)
    const after = await h.status(sessionId)
    expect(after[0].windows.some((w) => w.url.endsWith("page2.html"))).toBe(true)
    // The navigation bumps the generation whether or not it landed before the
    // click returned; either way the approved target is now stale.
    expect(typeof result.navigated).toBe("boolean")
    await expect(h.interact(sessionId, { action: "click", ref: link }, [approved])).rejects.toMatchObject({ code: "stale_ref" })
  }, 60_000)

  it("refuses automation during a handoff and after Stop", async () => {
    await h.beginHandoff(sessionId)
    await expect(h.snapshot(sessionId)).rejects.toMatchObject({ code: "handoff_active" })
    await h.endHandoff(sessionId)
    const snap = (await h.snapshot(sessionId)).text
    const stopped = new AbortController()
    stopped.abort()
    const late = manager.handleForTurn("c1", ws, stopped.signal)
    await expect(late.interact(sessionId, { action: "click", ref: ref(snap, "button", "Back home") })).rejects.toThrow()
    expect((await h.snapshot(sessionId)).text).toContain('heading "Page two"')
    // Another conversation cannot drive it.
    const other = manager.handleForTurn("c2", ws, new AbortController().signal)
    await expect(other.snapshot(sessionId)).rejects.toMatchObject({ code: "unknown_session" })
  }, 60_000)
})
