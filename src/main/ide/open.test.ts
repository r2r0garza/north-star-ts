import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock the OS-default opener and the process launcher. execFile is promisified in
// open.ts, so the mock must call the callback (promisify wraps a callback API).
const openPath = vi.fn(async () => "")
vi.mock("electron", () => ({ shell: { openPath: (p: string) => openPath(p) } }))

const execFileCalls: Array<{ cmd: string; args: string[] }> = []
let execFileImpl: (cmd: string, args: string[]) => void = () => {}
vi.mock("child_process", () => ({
  execFile: (cmd: string, args: string[], _opts: unknown, cb: Function) => {
    // promisify calls with (cmd, args, opts, cb) — opts may be omitted, so the
    // callback can arrive as the 3rd arg. Normalize.
    const callback = typeof _opts === "function" ? _opts : cb
    execFileCalls.push({ cmd, args })
    try {
      execFileImpl(cmd, args)
      callback(null, { stdout: "", stderr: "" })
    } catch (err) {
      callback(err)
    }
  },
}))

import { openInIde, IDES } from "./open"

beforeEach(() => {
  openPath.mockClear()
  execFileCalls.length = 0
  execFileImpl = () => {}
})

describe("openInIde", () => {
  it("uses the OS default (shell.openPath) for 'system'", async () => {
    const res = await openInIde("/repo", "/repo/src/a.ts", "system")
    expect(res).toBe("")
    expect(openPath).toHaveBeenCalledWith("/repo/src/a.ts")
    expect(execFileCalls).toHaveLength(0)
  })

  it("falls back to the OS default for an unknown IDE id", async () => {
    await openInIde("/repo", "/repo/src/a.ts", "not-an-ide")
    expect(openPath).toHaveBeenCalledWith("/repo/src/a.ts")
  })

  it("opens the repo root first, then the file, for a known IDE", async () => {
    const res = await openInIde("/repo", "/repo/src/a.ts", "vscode")
    expect(res).toBe("")
    // Two launches, root before file (both target paths appear as the last arg).
    const targets = execFileCalls.map((c) => c.args[c.args.length - 1])
    expect(targets).toEqual(["/repo", "/repo/src/a.ts"])
    expect(openPath).not.toHaveBeenCalled()
  })

  it("falls back to the OS default when the IDE can't be launched", async () => {
    // Every launch attempt fails (app + CLI both throw).
    execFileImpl = () => {
      throw new Error("not found")
    }
    const res = await openInIde("/repo", "/repo/src/a.ts", "zed")
    expect(res).toBe("")
    expect(openPath).toHaveBeenCalledWith("/repo/src/a.ts")
  })

  it("exposes a non-empty IDE registry with id + label", () => {
    expect(IDES.length).toBeGreaterThan(0)
    for (const entry of IDES) {
      expect(entry.id).toBeTruthy()
      expect(entry.label).toBeTruthy()
    }
  })
})
