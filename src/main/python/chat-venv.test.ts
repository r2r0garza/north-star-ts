import { describe, expect, it, vi } from "vitest"
import { join } from "path"

vi.mock("electron", () => ({
  app: { getName: () => "North Star" },
}))

import {
  chatVenvDir,
  ensureChatVenvWith,
  resolveChatVenvOverlay,
  type ChatVenvDeps,
} from "./chat-venv"

const HOME = "/Users/alice"
const VENV = join(HOME, ".north-star", "venv")
const VENV_PY = join(VENV, "bin", "python")

type Call = { file: string; args: string[] }

function harness(opts: {
  venvRuns?: boolean
  onPath?: string[]
  clt?: boolean
  createOk?: boolean
}) {
  const calls: Call[] = []
  let venvRuns = opts.venvRuns ?? false
  const deps: ChatVenvDeps = {
    platform: "darwin",
    home: HOME,
    env: async () => ({
      PATH: "/opt/homebrew/bin:/usr/bin",
      VIRTUAL_ENV: "/elsewhere",
    }),
    exists: async (path) => path !== VENV_PY || venvRuns,
    isExecutable: async (path) => (opts.onPath ?? []).includes(path),
    run: async (file, args, env) => {
      calls.push({ file, args })
      expect(env.VIRTUAL_ENV).toBeUndefined()
      if (file === VENV_PY) return { ok: venvRuns, output: "" }
      if (file === "/usr/bin/xcode-select")
        return { ok: opts.clt ?? false, output: "" }
      if (args.includes("venv")) {
        const ok = opts.createOk ?? true
        if (ok) venvRuns = true
        return { ok, output: ok ? "" : "boom" }
      }
      return { ok: false, output: "" }
    },
  }
  return { deps, calls }
}

describe("chatVenvDir", () => {
  it("lives under the system data dir", () => {
    expect(chatVenvDir(HOME)).toBe(VENV)
  })
})

describe("ensureChatVenvWith", () => {
  it("leaves a working venv alone", async () => {
    const { deps, calls } = harness({ venvRuns: true })
    expect(await ensureChatVenvWith(deps)).toEqual({
      state: "ready",
      dir: VENV,
    })
    expect(calls.some((c) => c.args.includes("venv"))).toBe(false)
  })

  it("creates the venv with the first python3 on the login PATH", async () => {
    const { deps, calls } = harness({
      onPath: ["/opt/homebrew/bin/python3", "/usr/bin/python3"],
    })
    expect(await ensureChatVenvWith(deps)).toEqual({
      state: "ready",
      dir: VENV,
    })
    expect(calls).toContainEqual({
      file: "/opt/homebrew/bin/python3",
      args: ["-m", "venv", "--clear", VENV],
    })
  })

  it("skips Apple's python3 stub when the Command Line Tools are missing", async () => {
    const { deps, calls } = harness({ onPath: ["/usr/bin/python3"] })
    const status = await ensureChatVenvWith(deps)
    expect(status.state).toBe("unavailable")
    expect(calls.some((c) => c.file === "/usr/bin/python3")).toBe(false)
  })

  it("uses Apple's python3 when the Command Line Tools are installed", async () => {
    const { deps, calls } = harness({ onPath: ["/usr/bin/python3"], clt: true })
    expect((await ensureChatVenvWith(deps)).state).toBe("ready")
    expect(calls.some((c) => c.file === "/usr/bin/python3")).toBe(true)
  })

  it("reports creation failures instead of throwing", async () => {
    const { deps } = harness({
      onPath: ["/opt/homebrew/bin/python3"],
      createOk: false,
    })
    const status = await ensureChatVenvWith(deps)
    expect(status).toMatchObject({ state: "unavailable" })
  })
})

describe("resolveChatVenvOverlay", () => {
  const ready = async () => ({ state: "ready" as const, dir: VENV })

  it("prepends the venv bin dir and sets VIRTUAL_ENV", async () => {
    const overlay = await resolveChatVenvOverlay("/work", {
      ensure: ready,
      managesPython: async () => false,
      platform: "darwin",
    })
    expect(overlay).toEqual({
      prependPath: [join(VENV, "bin")],
      vars: { VIRTUAL_ENV: VENV },
    })
  })

  it("steps aside when the workspace has its own Python environment", async () => {
    const overlay = await resolveChatVenvOverlay("/work", {
      ensure: ready,
      managesPython: async () => true,
    })
    expect(overlay).toBeNull()
  })

  it("applies to chats without a workspace", async () => {
    const managesPython = vi.fn(async () => true)
    const overlay = await resolveChatVenvOverlay(undefined, {
      ensure: ready,
      managesPython,
    })
    expect(overlay).not.toBeNull()
    expect(managesPython).not.toHaveBeenCalled()
  })

  it("is null when the venv is unavailable", async () => {
    const overlay = await resolveChatVenvOverlay("/work", {
      ensure: async () => ({ state: "unavailable", reason: "no python" }),
      managesPython: async () => false,
    })
    expect(overlay).toBeNull()
  })
})
