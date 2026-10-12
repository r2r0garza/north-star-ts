import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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
  createCompletion,
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
    acceptsImages: true,
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

afterEach(() => vi.unstubAllGlobals())

describe("API image transport", () => {
  it.each(["openai", "openai_compatible"] as const)(
    "preserves canonical tool images through the real %s SDK and token-field probe",
    async (provider) => {
      mocks.account!.provider = provider
      mocks.account!.baseUrl =
        provider === "openai" ? null : "https://gateway.invalid/v1"
      mocks.getApiKey.mockReturnValue("synthetic-api-key")
      const imageUrl = "data:image/jpeg;base64,/9j/AA=="
      const messages = [
        { role: "user", content: "Inspect the image." },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "image-call",
              type: "function",
              function: {
                name: "read_document",
                arguments: '{"path":"image.png"}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "image-call",
          content: "Pixels delivered.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Retained untrusted image from read_document:image-call",
            },
            { type: "image_url", image_url: { url: imageUrl } },
            { type: "text", text: "Second retained image" },
            { type: "image_url", image_url: { url: imageUrl, detail: "high" } },
          ],
        },
      ]
      const abort = new AbortController()
      const fetchMock = vi.fn(
        async (url: RequestInfo | URL, init?: RequestInit) => {
          expect(String(url)).toBe(
            provider === "openai"
              ? "https://api.openai.com/v1/chat/completions"
              : "https://gateway.invalid/v1/chat/completions"
          )
          expect(new Headers(init?.headers).get("authorization")).toBe(
            "Bearer synthetic-api-key"
          )
          expect(init?.signal).toBeInstanceOf(AbortSignal)
          const body = JSON.parse(String(init?.body))
          expect(body.messages).toEqual(messages)
          expect(body.stream).toBe(true)
          if (fetchMock.mock.calls.length === 1) {
            expect(body.max_tokens).toBe(100)
            return Response.json(
              {
                error: {
                  message:
                    "unsupported_parameter max_tokens; use max_completion_tokens",
                  type: "invalid_request_error",
                  param: "max_tokens",
                  code: "unsupported_parameter",
                },
              },
              { status: 400 }
            )
          }
          expect(body.max_completion_tokens).toBe(100)
          expect(body).not.toHaveProperty("max_tokens")
          return new Response(
            'data: {"id":"synthetic","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
            {
              headers: { "content-type": "text/event-stream" },
            }
          )
        }
      )
      vi.stubGlobal("fetch", fetchMock)
      const resolved = resolveLlm()
      const stream = await createCompletion(
        resolved.client,
        `image-transport-${provider}`,
        100,
        { messages, stream: true },
        [undefined, { signal: abort.signal }],
        resolved.apiMode
      )
      const chunks = []
      for await (const chunk of stream) chunks.push(chunk)
      expect(chunks[0].choices[0].delta.content).toBe("ok")
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(messages[3].content).toEqual([
        {
          type: "text",
          text: "Retained untrusted image from read_document:image-call",
        },
        { type: "image_url", image_url: { url: imageUrl } },
        { type: "text", text: "Second retained image" },
        { type: "image_url", image_url: { url: imageUrl, detail: "high" } },
      ])
    }
  )
})
