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
vi.mock("./auth-policy", async (original) => ({
  ...(await original<typeof import("./auth-policy")>()),
  verifyPersonalSubscription: mocks.auth,
}))
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
    expect(result.hint).toMatch(/personal Claude Pro or Max/)
    expect(JSON.stringify(result)).not.toMatch(/email@|bearer secret/)
    expect(mocks.close).toHaveBeenCalledOnce()
  })
  it.each(["organization_policy_unqualified", "routing_unqualified", "SECRET"])(
    "exposes only allowlisted compatibility guidance for %s",
    async (compatibility) => {
      mocks.auth.mockRejectedValue(
        Object.assign(
          new ClaudeSubscriptionError(
            "claude_subscription_account_unqualified",
            "email@example.test SECRET"
          ),
          { compatibility }
        )
      )
      const result = await preflightClaudeSubscription("/app-data")
      expect(result.ok).toBe(false)
      expect(JSON.stringify(result)).not.toMatch(/email@|SECRET/)
      expect(result.hint).toContain(
        compatibility === "organization_policy_unqualified"
          ? "managed-policy continuity"
          : compatibility === "routing_unqualified"
            ? "routing is unqualified"
            : "could not be verified"
      )
    }
  )
  it.each([
    [
      "claude_subscription_managed_policy_probe",
      "managed-policy sources",
      "managed_policy_probe",
    ],
    ["claude_subscription_cli_probe", "version probe failed", "cli_probe"],
    [
      "claude_subscription_private_state",
      "Private transport state",
      "private_state",
    ],
  ])(
    "identifies %s without raw native details",
    async (code, hint, diagnostic) => {
      mocks.version.mockRejectedValue(
        new ClaudeSubscriptionError(
          code,
          "secret token /private/work/settings.json"
        )
      )
      const result = await preflightClaudeSubscription("/app-data")
      expect(result.ok).toBe(false)
      expect(result.hint).toContain(hint)
      expect(result.hint).toContain(`[setup:version:${diagnostic}]`)
      expect(JSON.stringify(result)).not.toMatch(/secret|\/private\/work/)
      expect(mocks.auth).not.toHaveBeenCalled()
    }
  )
  it.each([
    ["env", "environment"],
    ["resolve", "executable"],
    ["files", "private_state"],
    ["version", "version"],
    ["auth", "authentication"],
    ["policy", "managed_policy"],
  ] as const)(
    "reports a fixed stage for unexpected %s failures",
    async (mock, stage) => {
      mocks[mock].mockRejectedValue(
        Object.assign(new Error("secret email@example.test"), {
          code: "SECRET_CODE",
        })
      )
      const result = await preflightClaudeSubscription("/app-data")
      expect(result.ok).toBe(false)
      expect(result.hint).toContain(`[setup:${stage}]`)
      expect(JSON.stringify(result)).not.toMatch(/secret|email@|SECRET_CODE/)
    }
  )
  it("does not expose unrecognized typed error codes", async () => {
    mocks.version.mockRejectedValue(
      new ClaudeSubscriptionError("SECRET_CODE", "secret")
    )
    const result = await preflightClaudeSubscription("/app-data")
    expect(result.hint).toContain("[setup:version]")
    expect(result.hint).not.toMatch(/SECRET_CODE|secret/)
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
