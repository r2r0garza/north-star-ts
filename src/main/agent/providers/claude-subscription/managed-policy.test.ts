import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("fs/promises", () => ({ lstat: vi.fn() }))
vi.mock("os", () => ({
  userInfo: vi.fn(() => ({ username: "fixture-user" })),
  homedir: () => "/fixture-home",
}))
vi.mock("child_process", () => ({ spawn: vi.fn(() => ({})) }))
vi.mock("../../env/spawn-util", () => ({ captureProcess: vi.fn() }))
import { captureProcess } from "../../env/spawn-util"
import { spawn } from "child_process"
import { lstat } from "fs/promises"
import { userInfo } from "os"
import { guardManagedPolicy } from "./managed-policy"

const sources = [
  "/Library/Application Support/ClaudeCode/managed-settings.json",
  "/Library/Application Support/ClaudeCode/managed-settings.d",
  "/Library/Application Support/ClaudeCode/managed-mcp.json",
  "/Library/Managed Preferences/com.anthropic.claudecode.plist",
  "/Library/Managed Preferences/fixture-user/com.anthropic.claudecode.plist",
  "/fixture-home/.claude/remote-settings.json",
]
const guard = () =>
  guardManagedPolicy({}, new AbortController().signal, "darwin")
const unmanaged = {
  exitCode: 0,
  stdout: Buffer.from("Enrolled via DEP: No\nMDM enrollment: No\n"),
}
const missing = () =>
  Promise.reject(Object.assign(new Error("SECRET"), { code: "ENOENT" }))
beforeEach(() => {
  vi.mocked(userInfo).mockReturnValue({ username: "fixture-user" } as any)
  vi.mocked(lstat).mockReset().mockImplementation(missing)
  vi.mocked(spawn).mockClear()
  vi.mocked(captureProcess)
    .mockReset()
    .mockResolvedValue(unmanaged as any)
})

describe("managed-policy preflight", () => {
  it.each([
    "Enrolled via DEP: Yes\nMDM enrollment: No",
    "Enrolled via DEP: No\nMDM enrollment: Yes (User Approved)",
  ])("rejects managed enrollment %s", async (status) => {
    vi.mocked(captureProcess).mockResolvedValue({
      ...unmanaged,
      stdout: Buffer.from(status),
    } as any)
    await expect(guard()).rejects.toMatchObject({
      code: "claude_subscription_managed_policy",
    })
  })
  it.each([
    { exitCode: 1 },
    { timedOut: true },
    { outputTruncated: true },
    { spawnError: new Error("SECRET") },
    { stdout: Buffer.from("unknown SECRET") },
  ])("fails closed on enrollment probe failure %s", async (result) => {
    vi.mocked(captureProcess).mockResolvedValue({
      ...unmanaged,
      ...result,
    } as any)
    await expect(guard()).rejects.toMatchObject({
      code: "claude_subscription_managed_policy_probe",
    })
    await expect(guard()).rejects.not.toThrow(/SECRET/)
  })
  it("uses the child config directory without opening remote policy", async () => {
    await guardManagedPolicy(
      { CLAUDE_CONFIG_DIR: "/synthetic-config" },
      new AbortController().signal,
      "darwin"
    )
    expect(lstat).toHaveBeenCalledWith("/synthetic-config/remote-settings.json")
  })
  it("does no work after cancellation", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      guardManagedPolicy({}, controller.signal, "darwin")
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(lstat).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })
  it("checks known source presence without reading policy or credential contents", async () => {
    await expect(guard()).resolves.toBeUndefined()
    expect(vi.mocked(lstat).mock.calls.map(([path]) => path)).toEqual(sources)
  })
  it.each(sources)(
    "rejects present source %s including symlinks or empty state",
    async (source) => {
      vi.mocked(lstat).mockImplementation((async (path: string) => {
        if (path === source) return {}
        return missing()
      }) as any)
      await expect(guard()).rejects.toMatchObject({
        code: "claude_subscription_managed_policy",
        status: undefined,
      })
      await expect(guard()).rejects.not.toThrow(/SECRET/)
    }
  )
  it.each(["EACCES", "EIO", "ENOTDIR"])(
    "fails closed on %s without exposing OS output",
    async (code) => {
      vi.mocked(lstat).mockRejectedValue(
        Object.assign(new Error("SECRET"), { code })
      )
      await expect(guard()).rejects.toMatchObject({
        code: "claude_subscription_managed_policy_probe",
        status: undefined,
      })
      await expect(guard()).rejects.not.toThrow(/SECRET/)
    }
  )
  it("fails closed if the OS user cannot be identified", async () => {
    vi.mocked(userInfo).mockImplementation(() => {
      throw new Error("SECRET")
    })
    await expect(guard()).rejects.toMatchObject({
      code: "claude_subscription_managed_policy_probe",
    })
    expect(lstat).not.toHaveBeenCalled()
  })
})
