import { beforeEach, describe, expect, it, vi } from "vitest"
import { win32 } from "path"
vi.mock("fs/promises", () => ({ lstat: vi.fn() }))
vi.mock("./windows-state", () => ({ guardWindowsRegistry: vi.fn() }))
import { lstat } from "fs/promises"
import { guardWindowsRegistry } from "./windows-state"
import { guardManagedPolicy } from "./managed-policy"

const env = { USERPROFILE: "C:\\synthetic home" }
const sources = [
  ...["managed-settings.json", "managed-settings.d", "managed-mcp.json"].map(
    (name) => win32.join("C:\\Program Files\\ClaudeCode", name)
  ),
  "C:\\synthetic home\\.claude\\remote-settings.json",
]
const guard = () =>
  guardManagedPolicy(env, new AbortController().signal, "win32")
beforeEach(() => {
  vi.mocked(lstat)
    .mockReset()
    .mockRejectedValue(Object.assign(new Error("SECRET"), { code: "ENOENT" }))
  vi.mocked(guardWindowsRegistry).mockReset().mockResolvedValue()
})
describe("Windows policy source preflight", () => {
  it("checks system sources and effective user config, then registry presence", async () => {
    await guard()
    expect(vi.mocked(lstat).mock.calls.map(([path]) => path)).toEqual(sources)
    expect(guardWindowsRegistry).toHaveBeenCalledOnce()
  })
  it.each(sources)(
    "rejects present %s without reading contents",
    async (source) => {
      vi.mocked(lstat).mockImplementation(async (path) => {
        if (path === source) return {} as any
        throw Object.assign(new Error("SECRET"), { code: "ENOENT" })
      })
      await expect(guard()).rejects.toMatchObject({
        code: "claude_subscription_managed_policy",
      })
      expect(guardWindowsRegistry).not.toHaveBeenCalled()
    }
  )
  it("fails closed on access errors", async () => {
    vi.mocked(lstat).mockRejectedValue(
      Object.assign(new Error("SECRET"), { code: "EACCES" })
    )
    await expect(guard()).rejects.toMatchObject({
      code: "claude_subscription_managed_policy_probe",
    })
    await expect(guard()).rejects.not.toThrow(/SECRET/)
  })
})
