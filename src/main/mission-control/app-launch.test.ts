import { mkdtempSync, rmSync } from "fs"
import { createServer, type Server } from "net"
import { tmpdir } from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { AppService } from "../../shared/mission-control/app-launch"
import {
  serviceEnvironment,
  serviceStatus,
  startServices,
  stopServices,
  testAppServices,
} from "./app-launch"

// Real processes: a tiny Node HTTP server or log printer per service.
const NODE = JSON.stringify(process.execPath)
const httpServer = (extra = "") =>
  `${NODE} -e "${extra}require('http').createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT),'127.0.0.1')"`
const printer = (text: string) =>
  `${NODE} -e "console.log('${text}'); setInterval(()=>{},1000)"`

function service(patch: Partial<AppService> & { key: string }): AppService {
  return {
    label: patch.key,
    command: httpServer(),
    cwd: "",
    port: "auto",
    ready: { http: "/" },
    readyTimeoutMs: 15_000,
    source: "user",
    ...patch,
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitDead(pid: number) {
  for (let i = 0; i < 40 && alive(pid); i++)
    await new Promise((r) => setTimeout(r, 50))
  return !alive(pid)
}

let roots: string[] = []
const root = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "app-launch-"))
  roots.push(dir)
  return dir
}

beforeEach(() => {
  roots = []
})

afterEach(async () => {
  await testAppServices.clear()
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(process.platform === "win32")("startServices", () => {
  it("waits for an HTTP service and returns its URL", async () => {
    const recipe = { services: [service({ key: "web" })] }
    const started = await startServices({ owner: "p1", root: root(), recipe })
    expect(started.ok).toBe(true)
    const [web] = started.services
    expect(web.status).toBe("ready")
    expect(web.url).toBe(`http://localhost:${web.port}`)
    const res = await fetch(`http://127.0.0.1:${web.port}/`)
    expect(await res.text()).toBe("ok")
  })

  it("waits for a log line", async () => {
    const recipe = {
      services: [
        service({
          key: "worker",
          port: "none",
          command: printer("worker listening"),
          ready: { log: "worker listening" },
        }),
      ],
    }
    const started = await startServices({ owner: "p1", root: root(), recipe })
    expect(started.ok).toBe(true)
    expect(started.services[0]).toMatchObject({ status: "ready", url: null })
  })

  it("times out with the output tail and stops the process", async () => {
    const recipe = {
      services: [
        service({
          key: "slow",
          command: printer("still booting"),
          readyTimeoutMs: 1000,
        }),
      ],
    }
    const dir = root()
    const started = await startServices({ owner: "p1", root: dir, recipe })
    expect(started.ok).toBe(false)
    if (started.ok) return
    expect(started.code).toBe("service_failed")
    expect(started.message).toMatch(/not ready after 1 seconds/)
    expect(started.services[0].outputTail).toContain("still booting")
    const pid = testAppServices.pids()[0]
    expect(await waitDead(pid)).toBe(true)
  })

  it("reports a service that exits before it's ready", async () => {
    const recipe = {
      services: [
        service({
          key: "crash",
          command: `${NODE} -e "console.error('boom'); process.exit(3)"`,
        }),
      ],
    }
    const started = await startServices({ owner: "p1", root: root(), recipe })
    expect(started.ok).toBe(false)
    expect(started.services[0].error).toMatch(
      /exited with 3 before it was ready/
    )
    expect(started.services[0].outputTail).toContain("boom")
  })

  it("gives two worktrees' same auto service different ports", async () => {
    const recipe = { services: [service({ key: "web" })] }
    const [a, b] = await Promise.all([
      startServices({ owner: "story-a", root: root(), recipe }),
      startServices({ owner: "story-b", root: root(), recipe }),
    ])
    expect(a.ok && b.ok).toBe(true)
    expect(a.services[0].port).not.toBe(b.services[0].port)
  })

  it("reuses a service the owner already started", async () => {
    const dir = root()
    const recipe = { services: [service({ key: "web" })] }
    const first = await startServices({ owner: "p1", root: dir, recipe })
    const again = await startServices({ owner: "p1", root: dir, recipe })
    expect(again.services[0].port).toBe(first.services[0].port)
    expect(testAppServices.size).toBe(1)
  })

  it("starts dependencies first and passes their ports", async () => {
    const recipe = {
      services: [
        service({
          key: "web",
          dependsOn: ["api"],
          env: { API_URL: "http://localhost:{port:api}" },
          command: httpServer("console.log('api is '+process.env.API_URL);"),
        }),
        service({ key: "api" }),
      ],
    }
    const dir = root()
    const started = await startServices({
      owner: "p1",
      root: dir,
      recipe,
      keys: ["web"],
    })
    expect(started.ok).toBe(true)
    expect(started.services.map((s) => s.key)).toEqual(["api", "web"])
    const api = started.services[0]
    const status = serviceStatus({
      owner: "p1",
      root: dir,
      recipe,
      logs: "web",
    })
    expect(status.find((s) => s.key === "web")?.outputTail).toContain(
      `api is http://localhost:${api.port}`
    )
    expect(serviceEnvironment(started.services).env).toMatchObject({
      BASE_URL: `http://localhost:${api.port}`,
      APP_API_PORT: String(api.port),
    })
  })

  it("names what holds a fixed port", async () => {
    const blocker: Server = createServer()
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", () => r()))
    const port = (blocker.address() as { port: number }).port
    try {
      const recipe = { services: [service({ key: "web", port })] }
      const started = await startServices({ owner: "p1", root: root(), recipe })
      expect(started.ok).toBe(false)
      expect(started.services[0].error).toMatch(
        new RegExp(`port ${port} is already in use by another process`)
      )
    } finally {
      blocker.close()
    }
  })

  it("refuses when there's no recipe", async () => {
    const started = await startServices({
      owner: "p1",
      root: root(),
      recipe: { services: [] },
    })
    expect(started).toMatchObject({ ok: false, code: "no_recipe" })
  })
})

describe.skipIf(process.platform === "win32")("stopServices", () => {
  it("leaves no process behind, including what the service spawned", async () => {
    // The service spawns a grandchild and prints its pid.
    const spawner = `${NODE} -e "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log('child '+c.pid); setInterval(()=>{},1000)"`
    const recipe = {
      services: [
        service({
          key: "tree",
          port: "none",
          command: spawner,
          ready: { log: "child \\d+" },
        }),
        service({ key: "web" }),
      ],
    }
    const dir = root()
    const started = await startServices({ owner: "phase-1", root: dir, recipe })
    expect(started.ok).toBe(true)
    const tail = serviceStatus({
      owner: "phase-1",
      root: dir,
      recipe,
      logs: "tree",
    })[0].outputTail!
    const grandchild = Number(/child (\d+)/.exec(tail)![1])
    const pids = [...testAppServices.pids(), grandchild]
    expect(pids.every(alive)).toBe(true)

    expect(await stopServices({ owner: "phase-1" })).toBe(2)
    for (const pid of pids) expect(await waitDead(pid)).toBe(true)
    expect(testAppServices.size).toBe(0)
  })

  it("stops only the owner's services", async () => {
    const recipe = { services: [service({ key: "web" })] }
    await startServices({ owner: "phase-1", root: root(), recipe })
    await startServices({ owner: "phase-2", root: root(), recipe })
    expect(await stopServices({ owner: "phase-1" })).toBe(1)
    expect(testAppServices.size).toBe(1)
  })
})
