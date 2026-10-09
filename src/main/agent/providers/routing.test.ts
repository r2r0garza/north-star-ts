import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ProviderAccount } from "../../db/types"

const mocks = vi.hoisted(() => ({
  account: undefined as ProviderAccount | undefined,
  models: [{ modelId: "sonnet" }],
  getApiKey: vi.fn(),
  build: vi.fn(),
  getPath: vi.fn(() => "/app-data"),
  touch: vi.fn(),
}))
vi.mock("electron", () => ({ app: { getPath: mocks.getPath } }))
vi.mock("../../db/repositories/provider-accounts", () => ({
  getAccount: () => mocks.account,
  listAccounts: () => (mocks.account ? [mocks.account] : []),
  touchLastUsed: mocks.touch,
}))
vi.mock("../../db/repositories/models", () => ({
  listModels: () => mocks.models,
}))
vi.mock("../../settings/service", () => ({
  getLlm: () => ({ activeAccountId: "account", activeModelId: "sonnet" }),
  setLlmChangeListener: vi.fn(),
}))
vi.mock("../../settings/secrets", () => ({
  getApiKey: mocks.getApiKey,
  setApiKey: vi.fn(),
}))
vi.mock("./claude-subscription/client", () => ({
  buildClaudeSubscriptionClient: mocks.build,
}))
import {
  clientForAccount,
  fetchGatewayModelIds,
  hasActiveProvider,
  invalidate,
  resolveLlm,
} from "./index"

beforeEach(() => {
  invalidate()
  vi.clearAllMocks()
  mocks.account = {
    id: "account",
    provider: "claude_subscription",
    displayName: "Subscription",
    baseUrl: null,
    hasKey: false,
    enabled: true,
    position: 0,
    apiMode: "completions",
    createdAt: 1,
    lastUsedAt: null,
  }
  mocks.models = [{ modelId: "sonnet" }]
  mocks.build.mockImplementation(() => ({
    compatibilityProbes: false,
    chat: { completions: { create: vi.fn() } },
    models: { list: vi.fn().mockResolvedValue({ data: [{ id: "sonnet" }] }) },
  }))
})

describe("Claude subscription routing", () => {
  it("resolves without reading secrets or requiring a base URL", () => {
    expect(hasActiveProvider()).toBe(true)
    const resolved = resolveLlm()
    expect(resolved).toMatchObject({
      accountId: "account",
      model: "sonnet",
      provider: "claude_subscription",
      apiMode: "completions",
    })
    expect(mocks.build).toHaveBeenCalledWith({ appData: "/app-data" })
    expect(mocks.getApiKey).not.toHaveBeenCalled()
    expect(mocks.touch).toHaveBeenCalledWith("account")
  })
  it("uses the discovery catalog for model listing", async () => {
    expect(await fetchGatewayModelIds("account")).toEqual(["sonnet"])
    expect(mocks.getApiKey).not.toHaveBeenCalled()
  })
  it("caches factories and invalidates only future resolutions", () => {
    const original = clientForAccount("account")
    expect(resolveLlm().client).toBe(original)
    expect(mocks.build).toHaveBeenCalledTimes(1)
    invalidate()
    expect(resolveLlm().client).not.toBe(original)
    expect(mocks.build).toHaveBeenCalledTimes(2)
  })
  it("requires an enabled account and stored model", () => {
    mocks.models = []
    expect(hasActiveProvider()).toBe(false)
    expect(() => resolveLlm()).toThrow(/no longer in/)
    mocks.models = [{ modelId: "sonnet" }]
    mocks.account!.enabled = false
    expect(hasActiveProvider()).toBe(false)
    expect(() => resolveLlm()).toThrow(/disabled/)
  })
  it("keeps autonomous CLI providers out of completion routing", () => {
    for (const provider of ["claude_code", "codex_cli"] as const) {
      mocks.account!.provider = provider
      expect(hasActiveProvider()).toBe(true)
      expect(() => resolveLlm()).toThrow(/not wired/)
    }
    expect(mocks.build).not.toHaveBeenCalled()
  })
  it("keeps API accounts dependent on their secret", () => {
    mocks.account!.provider = "openai"
    expect(hasActiveProvider()).toBe(false)
    expect(() => resolveLlm()).toThrow(/no API key/)
    expect(mocks.getApiKey).toHaveBeenCalledWith("account")
  })
})
