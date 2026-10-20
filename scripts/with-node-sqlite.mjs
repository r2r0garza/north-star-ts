import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

// Tests need better-sqlite3 built for Node; the app needs it built for
// Electron. The swap is done in place, so a session killed mid-way (agents
// SIGKILL the whole process group on abort/timeout) must not leave the Node
// build behind. The dirty marker records "not yet restored for Electron"; a
// detached guardian restores it if this process dies, and `--recover` (run
// before dev/start) repairs anything left over.
const stateDir = process.env.NORTH_STAR_NATIVE_STATE_DIR ?? "node_modules/.north-star"
const marker = `${stateDir}/native-abi-dirty`
const lock = `${stateDir}/native-rebuild.lock`
// Overridable so the regression test can drive a controlled, slow rebuild.
const rebuildForNode = argv("NORTH_STAR_NATIVE_REBUILD", ["npm", "rebuild", "better-sqlite3"])
const restoreForElectron = argv("NORTH_STAR_NATIVE_RESTORE", [
  "pnpm", "exec", "electron-rebuild", "-f", "-w", "better-sqlite3,node-pty",
])
const SIGNAL_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }

function argv(name, fallback) {
  return process.env[name] ? JSON.parse(process.env[name]) : fallback
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === "EPERM"
  }
}

async function acquireLock() {
  mkdirSync(stateDir, { recursive: true })
  for (let announced = false; ; ) {
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx" })
      return
    } catch (error) {
      if (error.code !== "EEXIST") throw error
    }
    const holder = Number(readFileSync(lock, "utf8"))
    // shortcut: two waiters stealing the same stale lock at once can both win; add an atomic rename if concurrent cleanup ever collides.
    if (!holder || !alive(holder)) {
      rmSync(lock, { force: true })
      continue
    }
    if (!announced) console.log(`Waiting for native rebuild held by pid ${holder}...`)
    announced = true
    await sleep(200)
  }
}

function releaseLock() {
  rmSync(lock, { force: true })
}

let current = null
function run([command, ...args]) {
  return new Promise((resolve) => {
    current = spawn(command, args, {
      stdio: "inherit",
      shell: process.platform === "win32",
    })
    current.on("error", (error) => {
      console.error(error)
      resolve(1)
    })
    current.on("close", (code) => {
      current = null
      resolve(code ?? 1)
    })
  })
}

async function restore() {
  console.log("Restoring native modules for Electron...")
  const status = await run(restoreForElectron)
  if (status === 0) rmSync(marker, { force: true })
  return status
}

async function recover() {
  await acquireLock()
  try {
    return existsSync(marker) ? await restore() : 0
  } finally {
    releaseLock()
  }
}

// Detached (own process group) so the group kill that took out the session
// does not take this out too.
async function guard(pid) {
  while (alive(pid)) await sleep(200)
  if (!existsSync(marker)) return 0
  console.error(`Test session ${pid} exited before restoring native modules; restoring.`)
  return recover()
}

async function session(command, args) {
  await acquireLock()
  writeFileSync(marker, String(process.pid))
  spawn(process.execPath, [fileURLToPath(import.meta.url), "--guard", String(process.pid)], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref()

  let interrupted = null
  for (const signal of Object.keys(SIGNAL_CODES)) {
    process.on(signal, () => {
      // Second signal while restoring: leave it to the guardian.
      if (interrupted) process.exit(SIGNAL_CODES[signal])
      interrupted = signal
      const child = current
      child?.kill(signal)
      setTimeout(() => child?.exitCode === null && child.kill("SIGKILL"), 5000).unref()
    })
  }

  let status = 1
  try {
    console.log("Rebuilding better-sqlite3 for the current Node runtime...")
    status = await run(rebuildForNode)
    if (status === 0 && !interrupted) status = await run([command, ...args])
  } finally {
    const restoreStatus = await restore()
    if (restoreStatus !== 0 && status === 0) status = restoreStatus
    releaseLock()
  }
  return interrupted ? SIGNAL_CODES[interrupted] : status
}

const [command, ...args] = process.argv.slice(2)
if (!command) {
  console.error("Usage: node scripts/with-node-sqlite.mjs <command> [args...] | --recover")
  process.exit(1)
}
process.exit(
  command === "--recover"
    ? await recover()
    : command === "--guard"
      ? await guard(Number(args[0]))
      : await session(command, args)
)
