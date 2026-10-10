import { beforeEach, expect, it, vi } from "vitest"

vi.mock("fs/promises", () => ({ lstat: vi.fn() }))
vi.mock("os", () => ({
  homedir: () => "/fixture-home",
  release: vi.fn(() => "7.0.0"),
  userInfo: vi.fn(),
}))
vi.mock("child_process", () => ({ spawn: vi.fn() }))
import { lstat } from "fs/promises"
import { release } from "os"
import { spawn } from "child_process"
import { guardManagedPolicy } from "./managed-policy"

const sources = [
  "/etc/claude-code/managed-settings.json",
  "/etc/claude-code/managed-settings.d",
  "/etc/claude-code/managed-mcp.json",
  "/fixture-home/.claude/remote-settings.json",
]
const guard = (env: NodeJS.ProcessEnv = {}) =>
  guardManagedPolicy(env, new AbortController().signal, "linux")
beforeEach(() => {
  vi.mocked(lstat)
    .mockReset()
    .mockRejectedValue(Object.assign(new Error("SECRET"), { code: "ENOENT" }))
  vi.mocked(release).mockReturnValue("7.0.0")
  vi.mocked(spawn).mockClear()
})
it("checks documented Linux sources without macOS enrollment or policy reads", async () => {
  await guard()
  expect(vi.mocked(lstat).mock.calls.map(([path]) => path)).toEqual(sources)
  expect(spawn).not.toHaveBeenCalled()
})
it.each(sources)(
  "rejects presence including symlinks at %s",
  async (source) => {
    vi.mocked(lstat).mockImplementation(async (path) => {
      if (path === source) return {} as any
      throw Object.assign(new Error("SECRET"), { code: "ENOENT" })
    })
    await expect(guard()).rejects.toMatchObject({
      code: "claude_subscription_managed_policy",
    })
  }
)
it.each(["EACCES", "ENOTDIR", "EIO", "ELOOP"])(
  "fails closed on %s",
  async (code) => {
    vi.mocked(lstat).mockRejectedValue(
      Object.assign(new Error("SECRET"), { code })
    )
    await expect(guard()).rejects.toMatchObject({
      code: "claude_subscription_managed_policy_probe",
    })
    await expect(guard()).rejects.not.toThrow(/SECRET/)
  }
)
it("uses the effective CLI config selector", async () => {
  await guard({
    HOME: "/synthetic-home",
    CLAUDE_CONFIG_DIR: "/synthetic-config",
  })
  expect(lstat).toHaveBeenCalledWith("/synthetic-config/remote-settings.json")
})
it.each([{ WSL_INTEROP: "/fixture" }, { WSL_DISTRO_NAME: "fixture" }])(
  "rejects WSL environment %j",
  async (env) => {
    await expect(guard(env)).rejects.toMatchObject({
      code: "claude_subscription_platform_unqualified",
    })
    expect(lstat).not.toHaveBeenCalled()
  }
)
it("rejects WSL kernel even without environment selectors", async () => {
  vi.mocked(release).mockReturnValue("6.6.87.2-microsoft-standard-WSL2")
  await expect(guard()).rejects.toMatchObject({
    code: "claude_subscription_platform_unqualified",
  })
})
