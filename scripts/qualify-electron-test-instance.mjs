// Plan 119 Phase A qualification: launch the built North Star dev app as an
// isolated test instance over CDP on --remote-debugging-pipe (fd 3 = to target,
// fd 4 = from target; no TCP listener), observe its primary window, capture a
// snapshot and screenshot, quit it, and verify the personal profile was not
// touched. Run `pnpm build` first. Writes nothing outside a temp dir.
import { spawn } from "node:child_process"
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const electron = require("electron")
const appDir = resolve(".")
if (!existsSync(join(appDir, "out/main/index.js")))
  throw new Error("out/main/index.js missing — run `pnpm build` first")

const started = Date.now()
const root = await mkdtemp(join(tmpdir(), "north-star-test-instance-"))
const checks = []
const check = (name, ok, detail = "") => {
  checks.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`)
}

// Minimal documented child env: no provider keys or inherited Node/Electron
// injection variables (NODE_OPTIONS, ELECTRON_RUN_AS_NODE, ...).
const env = { PATH: process.env.PATH ?? "", LANG: process.env.LANG ?? "" }
if (process.platform === "win32") env.SystemRoot = process.env.SystemRoot

const child = spawn(
  electron,
  ["--remote-debugging-pipe", appDir, `--test-profile=${root}`],
  { env, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] }
)
const output = []
child.stdout.on("data", (d) => output.push(String(d)))
child.stderr.on("data", (d) => output.push(String(d)))
const exited = new Promise((r) => child.on("exit", (code, signal) => r({ code, signal })))

let nextId = 0
let buffer = ""
const pending = new Map()
child.stdio[4].on("data", (chunk) => {
  buffer += chunk
  for (let i; (i = buffer.indexOf("\0")) >= 0; ) {
    const message = JSON.parse(buffer.slice(0, i))
    buffer = buffer.slice(i + 1)
    pending.get(message.id)?.(message)
    pending.delete(message.id)
  }
})
const send = (method, params = {}, sessionId) =>
  new Promise((resolveSend, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 10_000)
    pending.set(id, (m) => {
      clearTimeout(timer)
      m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolveSend(m.result)
    })
    child.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + "\0")
  })

async function primaryWindow() {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const { targetInfos } = await send("Target.getTargets")
    const pages = targetInfos.filter((t) => t.type === "page" && !t.url.startsWith("devtools:"))
    const ready = pages.find((t) => t.title.includes("(Test instance)"))
    if (ready) return { ready, pages }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error("no test-instance window within 30s")
}

try {
  const launchMs = Date.now()
  const { ready, pages } = await primaryWindow()
  check("primary window branded as test instance", true, `"${ready.title}" in ${Date.now() - launchMs} ms`)
  check("page targets are app-owned renderers", pages.every((p) => /^(file|http:\/\/localhost)/.test(p.url)), pages.map((p) => p.url).join(", "))

  const { sessionId } = await send("Target.attachToTarget", { targetId: ready.targetId, flatten: true })
  await send("Accessibility.enable", {}, sessionId)
  const { nodes } = await send("Accessibility.getFullAXTree", {}, sessionId)
  const actionable = nodes.filter((n) => ["button", "link", "textbox", "combobox"].includes(n.role?.value))
  check("accessibility snapshot has actionable nodes", actionable.length > 0, `${nodes.length} nodes, ${actionable.length} actionable`)

  const { data } = await send("Page.captureScreenshot", { format: "png" }, sessionId)
  const png = Buffer.from(data, "base64")
  await writeFile(join(root, "primary.png"), png)
  check("renderer screenshot captured", png.subarray(1, 4).toString() === "PNG", `${png.length} bytes`)

  await send("Browser.close").catch(() => {})
  const exit = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 10_000))])
  check("graceful quit exits the process", exit && exit.code === 0, JSON.stringify(exit))

  const userData = await readdir(join(root, "user-data"))
  check("SQLite database created in test profile", userData.some((f) => f.endsWith(".db")), userData.filter((f) => f.endsWith(".db")).join(", "))

  // Personal locations a dev North Star resolves; any file modified since launch
  // means the redirect leaked (or the controlling instance wrote concurrently).
  const personal = [
    join(homedir(), "Library/Application Support/north-star"),
    join(homedir(), process.env.APPDATA ?? ".config", "north-star"),
    ...(await readdir(homedir())).filter((d) => /^\.(north-star|cowork|processes)$/.test(d)).map((d) => join(homedir(), d)),
  ].filter(existsSync)
  const touched = []
  const walk = async (dir, depth) => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = join(dir, entry.name)
      if (entry.isDirectory() && depth < 3) await walk(full, depth + 1)
      else if (entry.isFile() && (await stat(full)).mtimeMs > started) touched.push(full)
    }
  }
  for (const dir of personal) await walk(dir, 0)
  check("personal profile untouched", touched.length === 0, touched.length ? touched.slice(0, 5).join(", ") : `checked ${personal.length} dirs`)
} catch (error) {
  check("qualification run", false, error.message)
  console.log(output.join("").slice(-2000))
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
  await exited
  if (process.env.KEEP_PROFILE) console.log(`profile kept at ${root}`)
  else await rm(root, { recursive: true, force: true })
}
process.exitCode = checks.every((c) => c.ok) ? 0 : 1
