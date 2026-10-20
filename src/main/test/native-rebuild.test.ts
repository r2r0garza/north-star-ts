import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

// Drives scripts/with-node-sqlite.mjs with a fake, slow native rebuild and
// kills it the way the agent does (SIGKILL to the whole process group) or the
// way a user does (SIGTERM to the wrapper), then checks the Electron build is
// back and nothing is left running or locked.
const wrapper = join(__dirname, "../../../scripts/with-node-sqlite.mjs")
const node = process.execPath

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "north-star-native-"))
  const abi = join(dir, "abi")
  const restores = join(dir, "restores")
  const testPid = join(dir, "test.pid")
  const write = (value: string) =>
    `require("fs").writeFileSync(${JSON.stringify(abi)}, ${JSON.stringify(value)})`
  const env = {
    ...process.env,
    NORTH_STAR_NATIVE_STATE_DIR: join(dir, "state"),
    NORTH_STAR_NATIVE_REBUILD: JSON.stringify([node, "-e", write("node")]),
    // Leaves a half-built module for 1.5s, like an interrupted compile would.
    NORTH_STAR_NATIVE_RESTORE: JSON.stringify([
      node,
      "-e",
      `${write("partial")}; require("fs").appendFileSync(${JSON.stringify(restores)}, "x"); setTimeout(() => { ${write("electron")} }, 1500)`,
    ]),
  }
  const longTest = [
    node,
    "-e",
    `require("fs").writeFileSync(${JSON.stringify(testPid)}, String(process.pid)); setInterval(() => {}, 1000)`,
  ]
  const start = (command: string[]) =>
    spawn(node, [wrapper, ...command], { env, detached: true, stdio: "ignore" })
  const read = (path: string) =>
    existsSync(path) ? readFileSync(path, "utf8") : ""
  return {
    abi: () => read(abi),
    restores: () => read(restores).length,
    testPid: () => Number(read(testPid)),
    marker: () => existsSync(join(dir, "state/native-abi-dirty")),
    lock: () => existsSync(join(dir, "state/native-rebuild.lock")),
    start,
    longTest,
  }
}

async function until(check: () => boolean, ms = 15_000) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out")
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe.skipIf(process.platform === "win32")("with-node-sqlite", () => {
  it("recovers when the session is killed mid-restore", async () => {
    const t = setup()
    const child = t.start([node, "-e", ""])
    await until(() => t.abi() === "partial")
    process.kill(-child.pid!, "SIGKILL")

    await until(() => t.abi() === "electron" && !t.marker() && !t.lock())
    expect(t.restores()).toBe(2)
  }, 20_000)

  it("reaps a long-running test session killed by the agent and restores", async () => {
    const t = setup()
    const child = t.start(t.longTest)
    await until(() => t.testPid() > 0)
    expect(t.abi()).toBe("node")
    process.kill(-child.pid!, "SIGKILL")

    await until(() => t.abi() === "electron" && !t.marker() && !t.lock())
    expect(alive(t.testPid())).toBe(false)
  }, 20_000)

  it("terminates the test session and restores itself on SIGTERM", async () => {
    const t = setup()
    const child = t.start(t.longTest)
    const exit = new Promise<number | null>((resolve) =>
      child.on("exit", resolve)
    )
    await until(() => t.testPid() > 0)
    child.kill("SIGTERM")

    expect(await exit).toBe(143)
    expect(alive(t.testPid())).toBe(false)
    expect(t.abi()).toBe("electron")
    expect(t.marker()).toBe(false)
    expect(t.lock()).toBe(false)
    expect(t.restores()).toBe(1)
  }, 20_000)
})
