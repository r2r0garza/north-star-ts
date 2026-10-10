import { beforeEach, describe, expect, it, vi } from "vitest"
import { ClaudeSubscriptionError } from "./errors"
const mocks = vi.hoisted(() => ({
  env: vi.fn(),
  guard: vi.fn(),
  resolve: vi.fn(),
  files: vi.fn(),
  version: vi.fn(),
  auth: vi.fn(),
  policy: vi.fn(),
  close: vi.fn(),
}))
vi.mock("../../env/host-cli-env", () => ({ hostCliEnv: mocks.env }))
vi.mock("./setup", () => ({
  guardEnvironment: mocks.guard,
  resolveExecutable: mocks.resolve,
  privateDirectories: mocks.files,
  probeCliVersion: mocks.version,
}))
vi.mock("./auth-policy", () => ({ verifyPersonalSubscription: mocks.auth }))
vi.mock("./managed-policy", () => ({ guardManagedPolicy: mocks.policy }))
import { preflightClaudeSubscription } from "./preflight"
beforeEach(() => {
  vi.resetAllMocks()
  mocks.env.mockResolvedValue({ PATH: "/native/bin" })
  mocks.guard.mockReturnValue({ PATH: "/guarded/bin" })
  mocks.resolve.mockResolvedValue("/guarded/bin/claude")
  mocks.files.mockResolvedValue({ cwd: "/private/cwd", close: mocks.close })
  mocks.version.mockResolvedValue("2.1.295")
  mocks.auth.mockResolvedValue(undefined)
  mocks.policy.mockResolvedValue(undefined)
})
describe("safe subscription preflight", () => {
  it("uses guarded host environment and exposes only safe readiness metadata", async () => {
    const result = await preflightClaudeSubscription("/app-data")
    expect(result).toMatchObject({
      ok: true,
      installed: true,
      version: "2.1.295",
      compatible: true,
      loggedIn: true,
    })
    expect(mocks.auth).toHaveBeenCalledWith(
      "/guarded/bin/claude",
      "/private/cwd",
      { PATH: "/guarded/bin" },
      expect.any(AbortSignal)
    )
    expect(mocks.close).toHaveBeenCalledOnce()
    expect(JSON.stringify(result)).not.toContain("/guarded")
  })
  it("reports missing CLI with user-owned install guidance", async () => {
    mocks.resolve.mockRejectedValue(
      new ClaudeSubscriptionError("claude_subscription_cli_missing", "secret")
    )
    const result = await preflightClaudeSubscription("/app-data")
    expect(result).toMatchObject({
      ok: false,
      installed: false,
      compatible: null,
      loggedIn: null,
    })
    expect(result.hint).toMatch(/yourself/)
    expect(JSON.stringify(result)).not.toContain("secret")
  })
  it("reports incompatible version without raw stdout", async () => {
    mocks.version.mockRejectedValue(
      new ClaudeSubscriptionError(
        "claude_subscription_cli_incompatible",
        "raw secret"
      )
    )
    expect(await preflightClaudeSubscription("/app-data")).toMatchObject({
      ok: false,
      installed: true,
      compatible: false,
      version: null,
      loggedIn: null,
    })
    expect(mocks.auth).not.toHaveBeenCalled()
    expect(mocks.close).toHaveBeenCalledOnce()
  })
  it("does not equate an unqualified auth state to logged out or expose account data", async () => {
    mocks.auth.mockRejectedValue(
      new ClaudeSubscriptionError(
        "claude_subscription_account_unqualified",
        "email@example.test bearer secret"
      )
    )
    const result = await preflightClaudeSubscription("/app-data")
    expect(result).toMatchObject({
      ok: false,
      installed: true,
      compatible: true,
      loggedIn: null,
    })
    expect(result.hint).toMatch(/personal Pro or Max/)
    expect(JSON.stringify(result)).not.toMatch(/email@|bearer secret/)
    expect(mocks.close).toHaveBeenCalledOnce()
  })
  it("sanitizes unexpected failures", async () => {
    mocks.guard.mockImplementation(() => {
      throw new Error("private email token")
    })
    const result = await preflightClaudeSubscription("/app-data")
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain("private email token")
    expect(mocks.resolve).not.toHaveBeenCalled()
  })
})
