import { beforeEach, describe, expect, it, vi } from "vitest"
vi.mock("child_process", () => ({ spawn: vi.fn(() => ({})) }))
vi.mock("../../env/spawn-util", () => ({ captureProcess: vi.fn() }))
import { spawn } from "child_process"
import { captureProcess } from "../../env/spawn-util"
import {
  assessAuthCompatibility,
  validatePersonalSubscription,
  verifyPersonalSubscription,
} from "./auth-policy"
const personal = {
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  subscriptionType: "pro",
}
const signal = () => new AbortController().signal
beforeEach(() => {
  vi.mocked(spawn).mockClear()
  vi.mocked(captureProcess)
    .mockReset()
    .mockResolvedValue({
      exitCode: 0,
      stdout: Buffer.from(JSON.stringify(personal)),
    } as any)
})
describe("personal subscription policy eligibility", () => {
  it.each(["pro", "max"])(
    "accepts reported personal %s",
    (subscriptionType) => {
      expect(() =>
        validatePersonalSubscription(
          JSON.stringify({ ...personal, subscriptionType })
        )
      ).not.toThrow()
    }
  )
  it.each([
    { subscriptionType: "team" },
    { subscriptionType: "enterprise" },
    { subscriptionType: null },
    { subscriptionType: "unknown" },
    { loggedIn: false },
    { authMethod: "oauth_token" },
    { authMethod: "api_key" },
    { apiProvider: "customEndpoint" },
  ])("rejects unsupported status %s without exposing metadata", (change) => {
    expect(() =>
      validatePersonalSubscription(
        JSON.stringify({ ...personal, ...change, email: "SECRET" })
      )
    ).toThrow(/personal Claude Pro or Max/)
    expect(() =>
      validatePersonalSubscription(
        JSON.stringify({ ...personal, ...change, email: "SECRET" })
      )
    ).not.toThrow(/SECRET/)
  })
  it.each(["SECRET", "null", "[]", "{}"])(
    "rejects malformed or absent metadata %s",
    (output) => {
      expect(() => validatePersonalSubscription(output)).toThrow()
    }
  )
  it.each([
    [personal, "qualified_personal"],
    [{ ...personal, loggedIn: false }, "not_logged_in"],
    [
      { ...personal, subscriptionType: "enterprise" },
      "organization_policy_unqualified",
    ],
    [{ ...personal, apiProvider: "newRoute" }, "routing_unqualified"],
    [{ ...personal, authMethod: "newAuth" }, "authentication_unqualified"],
    [
      { ...personal, subscriptionType: "newTier" },
      "authentication_unqualified",
    ],
    [{}, "status_unavailable"],
  ])(
    "classifies sanitized compatibility without granting new capabilities",
    (status, expected) => {
      expect(
        assessAuthCompatibility(JSON.stringify({ ...status, email: "SECRET" }))
      ).toBe(expected)
    }
  )
  it("rejects category drift on a subsequent probe", async () => {
    await verifyPersonalSubscription("/claude", "/private", {}, signal())
    vi.mocked(captureProcess).mockResolvedValue({
      exitCode: 0,
      stdout: Buffer.from(
        JSON.stringify({ ...personal, subscriptionType: "team" })
      ),
    } as any)
    await expect(
      verifyPersonalSubscription("/claude", "/private", {}, signal())
    ).rejects.toThrow(/managed-policy continuity/)
  })
  it("uses bounded official status command without a relay or query", async () => {
    await verifyPersonalSubscription("/claude", "/private", {}, signal())
    expect(spawn).toHaveBeenCalledWith(
      "/claude",
      ["auth", "status", "--json"],
      expect.objectContaining({ cwd: "/private" })
    )
    expect(captureProcess).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        timeoutMs: 5000,
        maxOutputBytes: 16384,
        killGroup: true,
      })
    )
  })
  it.each([
    { timedOut: true },
    { outputTruncated: true },
    { exitCode: 1 },
    { spawnError: new Error("SECRET") },
  ])("rejects failed probe %s", async (change) => {
    vi.mocked(captureProcess).mockResolvedValue({
      exitCode: 0,
      ...change,
    } as any)
    await expect(
      verifyPersonalSubscription("/claude", "/private", {}, signal())
    ).rejects.toMatchObject({ code: "claude_subscription_account_unqualified" })
  })
  it.each([
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
    "claude_code_oauth_token",
    "Claude_Code_Oauth_Token_File_Descriptor",
  ])("rejects unclassified token source %s", async (key) => {
    await expect(
      verifyPersonalSubscription(
        "/claude",
        "/private",
        { [key]: "SECRET" },
        signal()
      )
    ).rejects.toMatchObject({ code: "claude_subscription_account_unqualified" })
    expect(spawn).not.toHaveBeenCalled()
  })
  it("honors cancellation before probing", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      verifyPersonalSubscription("/claude", "/private", {}, controller.signal)
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(spawn).not.toHaveBeenCalled()
  })
})
