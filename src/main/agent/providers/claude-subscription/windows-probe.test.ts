import { beforeEach, describe, expect, it, vi } from "vitest"
vi.mock("child_process", () => ({ spawn: vi.fn(() => ({})) }))
vi.mock("../../env/spawn-util", () => ({ captureProcess: vi.fn() }))
import { spawn } from "child_process"
import { captureProcess } from "../../env/spawn-util"
import { guardWindowsRegistry, windowsPrivatePaths } from "./windows-state"
beforeEach(() => {
  vi.stubEnv("SystemRoot", "C:\\Windows")
  vi.mocked(captureProcess)
    .mockReset()
    .mockResolvedValue({
      exitCode: 0,
      stdout: Buffer.from("absent\r\n"),
    } as any)
  vi.mocked(spawn).mockClear()
})
describe("Windows registry presence probe", () => {
  it("checks both hives and registry views without fetching values", async () => {
    await expect(
      guardWindowsRegistry({}, new AbortController().signal)
    ).resolves.toBeUndefined()
    const args = vi.mocked(spawn).mock.calls[0][1] as string[]
    const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le")
    for (const fragment of [
      "LocalMachine",
      "CurrentUser",
      "Registry64",
      "Registry32",
      "OpenSubKey",
    ])
      expect(script).toContain(fragment)
    expect(script).not.toContain("GetValue")
  })
  it.each([
    { stdout: Buffer.from("present") },
    { stdout: Buffer.from("SECRET") },
    { exitCode: 1 },
    { timedOut: true },
    { outputTruncated: true },
    { spawnError: "SECRET" },
  ])("fails closed on presence or failed probe %j", async (result) => {
    vi.mocked(captureProcess).mockResolvedValue({
      exitCode: 0,
      stdout: Buffer.from("absent"),
      ...result,
    } as any)
    await expect(
      guardWindowsRegistry({}, new AbortController().signal)
    ).rejects.toThrow()
    await expect(
      guardWindowsRegistry({}, new AbortController().signal)
    ).rejects.not.toThrow(/SECRET/)
  })
})

describe("batched Windows private state probe", () => {
  it("verifies all paths in one hidden process without interpolating paths into code", async () => {
    vi.mocked(captureProcess).mockResolvedValue({
      exitCode: 0,
      stdout: Buffer.from("private\r\n"),
    } as any)
    const paths = [
      { path: "C:\\private é\\root", create: true },
      { path: "C:\\private é\\file ' test.txt" },
    ]
    await windowsPrivatePaths(paths)
    expect(spawn).toHaveBeenCalledTimes(1)
    const [, args, options] = vi.mocked(spawn).mock.calls[0]
    expect(options).toMatchObject({
      windowsHide: true,
      env: { NS_PRIVATE_PATHS: JSON.stringify(paths) },
    })
    const script = Buffer.from((args as string[]).at(-1)!, "base64").toString(
      "utf16le"
    )
    expect(script).toContain("foreach ($entry")
    expect(script).toContain("ReparsePoint")
    expect(script).toContain("GetOwner")
    expect(script).toContain("public access")
    expect(script).not.toContain(paths[1].path)
  })
  it("fails closed without revealing probe output", async () => {
    vi.mocked(captureProcess).mockResolvedValue({
      exitCode: 1,
      stdout: Buffer.from("SECRET"),
    } as any)
    await expect(
      windowsPrivatePaths([{ path: "C:\\private" }])
    ).rejects.toMatchObject({ code: "claude_subscription_private_state" })
    await expect(
      windowsPrivatePaths([{ path: "C:\\private" }])
    ).rejects.not.toThrow(/SECRET/)
  })
})
