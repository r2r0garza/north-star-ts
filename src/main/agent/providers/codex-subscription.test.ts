import { describe, expect, it } from "vitest"
import {
  buildCodexSubscriptionRequest,
  completeCodexSubscriptionDeviceAuth,
  codexSubscriptionResponseToChat,
  buildCodexSubscriptionClient,
  parseCodexSubscriptionModels,
  probeCodexSubscriptionModelEndpointCandidates,
  probeCodexSubscriptionModelsEndpoint,
  preflightCodexSubscriptionBackend,
  redactCodexSubscriptionError,
  resolveCodexSubscriptionAuth,
  requestCodexSubscriptionDeviceCode,
} from "./codex-subscription"

function jwtWithExp(
  exp: number,
  extraClaims: Record<string, unknown> = {}
): string {
  const b64 = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${b64({ alg: "none" })}.${b64({ exp, ...extraClaims })}.sig`
}

describe("codex subscription adapter", () => {
  it("builds a Responses-style request from chat messages and tools", () => {
    const request = buildCodexSubscriptionRequest({
      model: "gpt-5.5",
      maxOutputTokens: 123,
      body: {
        messages: [
          { role: "system", content: "You are careful." },
          { role: "user", content: "Check this" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "read_file", arguments: '{"path":"a"}' },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_1",
            content: "file contents",
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "read_file",
              description: "Read a file",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      },
    })

    expect(request).toMatchObject({
      model: "gpt-5.5",
      instructions: "You are careful.",
      stream: true,
      store: false,
      input: [
        { role: "user", content: "Check this" },
        {
          type: "function_call",
          call_id: "call_1",
          name: "read_file",
          arguments: '{"path":"a"}',
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "file contents",
        },
      ],
      tools: [
        {
          type: "function",
          name: "read_file",
          description: "Read a file",
          strict: false,
          parameters: { type: "object", properties: {} },
        },
      ],
    })
    expect(request).not.toHaveProperty("max_output_tokens")
  })

  it("normalizes assistant text and function calls to chat completion choices", () => {
    const chat = codexSubscriptionResponseToChat({
      id: "resp_1",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Use a tool." }],
        },
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "read_file",
          arguments: '{"path":"a"}',
        },
      ],
    })

    expect(chat.choices[0]).toMatchObject({
      finish_reason: "tool_calls",
      message: {
        content: "Use a tool.",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"a"}' },
          },
        ],
      },
    })
  })

  it("assembles a streamed Codex response from SSE events", async () => {
    const client = buildCodexSubscriptionClient({
      bearerToken: "access-token",
      fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({ stream: true })
        return new Response(
          [
            'data: {"type":"response.output_text.delta","delta":"hel"}',
            "",
            'data: {"type":"response.output_text.delta","delta":"lo"}',
            "",
            'data: {"type":"response.completed","response":{"id":"resp_stream","status":"completed","usage":{"input_tokens":1}}}',
            "",
          ].join("\n"),
          { headers: { "content-type": "text/event-stream" } }
        )
      },
    })

    const result = (await client.chat.completions.create({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
    })) as { choices: Array<{ message: { content: string } }> }

    expect(result.choices[0].message.content).toBe("hello")
  })

  it("assembles SSE streams that use event lines and omit event type in data", async () => {
    const client = buildCodexSubscriptionClient({
      bearerToken: "access-token",
      fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({ stream: true })
        return new Response(
          [
            "event: response.output_text.delta",
            'data: {"delta":"hey"}',
            "",
            "event: response.completed",
            'data: {"response":{"id":"resp_event","status":"completed"}}',
            "",
          ].join("\n")
        )
      },
    })

    const result = (await client.chat.completions.create({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
    })) as { choices: Array<{ message: { content: string } }> }

    expect(result.choices[0].message.content).toBe("hey")
  })

  it("redacts authorization material in errors", () => {
    expect(
      redactCodexSubscriptionError(
        "401 Authorization: Bearer sess-abc cookie=oai-did=secret access_token=raw"
      )
    ).toBe(
      "401 Authorization: Bearer [redacted] cookie=[redacted] access_token=[redacted]"
    )
  })

  it("parses common Codex model catalog shapes", () => {
    expect(
      parseCodexSubscriptionModels({
        data: [
          { id: "gpt-5.6-sol" },
          { model: "gpt-5.6-terra" },
          { slug: "gpt-5.6-luna" },
        ],
      })
    ).toEqual(["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"])

    expect(
      parseCodexSubscriptionModels({
        models: [
          {
            slug: "gpt-5.6-terra",
            visibility: "list",
            priority: 20,
            shell_type: "default",
          },
          {
            slug: "gpt-5.5-wm",
            visibility: "list",
            priority: 10,
            shell_type: "default",
          },
          {
            slug: "gpt-5.6-sol",
            visibility: "list",
            priority: 5,
            shell_type: "default",
          },
          {
            slug: "gpt-6.0-ultra",
            visibility: "list",
            priority: 15,
            shell_type: "default",
          },
          {
            slug: "gpt-5.6-luna",
            visibility: "hidden",
            priority: 1,
            shell_type: "default",
          },
          {
            slug: "gpt-5.6-terra",
            visibility: "list",
            priority: 30,
            shell_type: "default",
          },
          {
            slug: "gpt-4o",
            visibility: "list",
            priority: 40,
            shell_type: "default",
          },
          {
            slug: "gpt-5.6-disabled",
            visibility: "list",
            priority: 50,
            shell_type: "disabled",
          },
        ],
      })
    ).toEqual(["gpt-5.6-sol", "gpt-6.0-ultra", "gpt-5.6-terra"])
  })

  it("fetches the Codex subscription model catalog", async () => {
    const token = jwtWithExp(999, {
      "https://api.openai.com/auth.chatgpt_account_id": "account-1",
    })
    const client = buildCodexSubscriptionClient({
      baseUrl: "https://chatgpt.com/backend-api/codex",
      bearerToken: token,
      fetchImpl: async (url: RequestInfo | URL, init?: RequestInit) => {
        const requested = new URL(String(url))
        expect(requested.origin + requested.pathname).toBe(
          "https://chatgpt.com/backend-api/codex/models"
        )
        expect(requested.searchParams.get("client_version")).toBe("0.151.0")
        expect(init?.method).toBe("GET")
        expect(init?.headers).toMatchObject({
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "chatgpt-account-id": "account-1",
          originator: "codex_cli_rs",
          "openai-beta": "responses=experimental",
        })
        expect((init?.headers as Record<string, string>)["user-agent"]).toMatch(
          /^codex_cli_rs\/0\.151\.0 /
        )
        return Response.json({
          models: [
            {
              slug: "gpt-5.6-sol",
              visibility: "list",
              priority: 1,
              shell_type: "default",
            },
            {
              slug: "gpt-4o",
              visibility: "list",
              priority: 2,
              shell_type: "default",
            },
          ],
        })
      },
    })

    await expect(client.models.list()).resolves.toEqual({
      data: [{ id: "gpt-5.6-sol" }],
    })
  })

  it("returns the raw Codex subscription model catalog probe body", async () => {
    const result = await probeCodexSubscriptionModelsEndpoint({
      baseUrl: "https://chatgpt.com/backend-api/codex",
      bearerToken: "access-token",
      fetchImpl: async (url: RequestInfo | URL, init?: RequestInit) => {
        const requested = new URL(String(url))
        expect(requested.origin + requested.pathname).toBe(
          "https://chatgpt.com/backend-api/codex/models"
        )
        expect(requested.searchParams.get("client_version")).toBe("0.151.0")
        expect(init?.headers).toMatchObject({
          accept: "application/json",
          authorization: "Bearer access-token",
        })
        return Response.json({ detail: "ok" }, { status: 202 })
      },
    })

    expect(result).toEqual({
      endpoint:
        "https://chatgpt.com/backend-api/codex/models?client_version=0.151.0",
      status: 202,
      ok: true,
      body: '{"detail":"ok"}',
    })
  })

  it("probes candidate ChatGPT model catalog endpoints", async () => {
    const seen: string[] = []
    const results = await probeCodexSubscriptionModelEndpointCandidates({
      baseUrl: "https://chatgpt.com/backend-api/codex",
      bearerToken: "access-token",
      fetchImpl: async (url: RequestInfo | URL) => {
        seen.push(String(url))
        return Response.json({ models: [] })
      },
    })

    expect(seen).toEqual([
      "https://chatgpt.com/backend-api/codex/models?client_version=0.151.0",
    ])
    expect(results).toHaveLength(1)
  })

  it("refreshes Codex auth when the model catalog rejects the access token", async () => {
    const persisted: string[] = []
    const initialToken = jwtWithExp(Math.floor(Date.now() / 1000) + 3600)
    const refreshedToken = jwtWithExp(Math.floor(Date.now() / 1000) + 7200)
    let catalogCalls = 0
    const client = buildCodexSubscriptionClient({
      bearerToken: JSON.stringify({
        access_token: initialToken,
        refresh_token: "refresh-me",
      }),
      persistSecret: (next) => {
        persisted.push(next)
      },
      fetchImpl: async (url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url) === "https://auth.openai.com/oauth/token") {
          return Response.json({ access_token: refreshedToken })
        }
        catalogCalls += 1
        const requested = new URL(String(url))
        expect(requested.origin + requested.pathname).toBe(
          "https://chatgpt.com/backend-api/codex/models"
        )
        expect(requested.searchParams.get("client_version")).toBe("0.151.0")
        expect((init?.headers as Record<string, string>).authorization).toBe(
          catalogCalls === 1
            ? `Bearer ${initialToken}`
            : `Bearer ${refreshedToken}`
        )
        if (catalogCalls === 1) {
          return Response.json(
            { error: { message: "expired" } },
            { status: 401 }
          )
        }
        return Response.json({ data: [{ id: "gpt-5.6-sol" }] })
      },
    })

    await expect(client.models.list()).resolves.toEqual({
      data: [{ id: "gpt-5.6-sol" }],
    })
    expect(persisted).toHaveLength(1)
  })

  it("classifies preflight auth failures without exposing tokens", async () => {
    const response = await preflightCodexSubscriptionBackend({
      baseUrl: "https://chatgpt.com/backend-api/codex",
      bearerToken: "secret-token",
      fetchImpl: async (_url: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.method).toBe("HEAD")
        expect(init?.headers).toMatchObject({
          authorization: "Bearer secret-token",
        })
        return new Response("expired Bearer secret-token", { status: 401 })
      },
    })

    expect(response).toEqual({
      ok: false,
      error:
        "Codex subscription auth was rejected or expired. Refresh credentials or use Codex CLI instead.",
    })
  })

  it("runs the device-code auth exchange and returns an encrypted-store payload", async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const fetchImpl = async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body })
      if (String(url).endsWith("/api/accounts/deviceauth/usercode")) {
        return Response.json({
          user_code: "ABCD-EFGH",
          device_auth_id: "device-1",
          interval: 1,
        })
      }
      if (String(url).endsWith("/api/accounts/deviceauth/token")) {
        return Response.json({
          authorization_code: "auth-code",
          code_verifier: "verifier",
        })
      }
      if (String(url) === "https://auth.openai.com/oauth/token") {
        return Response.json({
          access_token: "access-token",
          refresh_token: "refresh-token",
        })
      }
      return new Response("not found", { status: 404 })
    }

    const device = await requestCodexSubscriptionDeviceCode({ fetchImpl })
    const secret = await completeCodexSubscriptionDeviceAuth({
      deviceAuthId: device.deviceAuthId,
      userCode: device.userCode,
      intervalSeconds: device.intervalSeconds,
      fetchImpl,
      sleep: async () => undefined,
    })

    expect(device).toMatchObject({
      userCode: "ABCD-EFGH",
      verificationUri: "https://auth.openai.com/codex/device",
    })
    expect(JSON.parse(secret)).toMatchObject({
      access_token: "access-token",
      refresh_token: "refresh-token",
      auth_mode: "chatgpt_device_code",
    })
    expect(calls.map((call) => call.url)).toEqual([
      "https://auth.openai.com/api/accounts/deviceauth/usercode",
      "https://auth.openai.com/api/accounts/deviceauth/token",
      "https://auth.openai.com/oauth/token",
    ])
  })

  it("refreshes an expiring OAuth payload and persists rotated tokens", async () => {
    const persisted: string[] = []
    const secret = JSON.stringify({
      access_token: jwtWithExp(100),
      refresh_token: "old-refresh",
    })

    const auth = await resolveCodexSubscriptionAuth({
      secret,
      nowMs: 100_000,
      persistSecret: (next) => {
        persisted.push(next)
      },
      fetchImpl: async (url: RequestInfo | URL, init?: RequestInit) => {
        expect(String(url)).toBe("https://auth.openai.com/oauth/token")
        expect(String(init?.body)).toContain("grant_type=refresh_token")
        expect(String(init?.body)).toContain("refresh_token=old-refresh")
        return Response.json({
          access_token: jwtWithExp(999),
          refresh_token: "new-refresh",
        })
      },
    })

    expect(auth.accessToken).toBe(jwtWithExp(999))
    expect(auth.refreshed).toBe(true)
    expect(persisted).toHaveLength(1)
    expect(JSON.parse(persisted[0])).toMatchObject({
      access_token: jwtWithExp(999),
      refresh_token: "new-refresh",
    })
  })

  it("refreshes and retries once when the backend rejects an access token", async () => {
    const persisted: string[] = []
    const statuses: number[] = []
    const initialToken = jwtWithExp(Math.floor(Date.now() / 1000) + 3600)
    const refreshedToken = jwtWithExp(Math.floor(Date.now() / 1000) + 7200)
    const client = buildCodexSubscriptionClient({
      bearerToken: JSON.stringify({
        access_token: initialToken,
        refresh_token: "refresh-me",
      }),
      persistSecret: (next) => {
        persisted.push(next)
      },
      fetchImpl: async (url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url) === "https://auth.openai.com/oauth/token") {
          return Response.json({ access_token: refreshedToken })
        }
        statuses.push(statuses.length)
        expect((init?.headers as Record<string, string>).authorization).toBe(
          statuses.length === 1
            ? `Bearer ${initialToken}`
            : `Bearer ${refreshedToken}`
        )
        if (statuses.length === 1) {
          return Response.json(
            { error: { message: "expired" } },
            { status: 401 }
          )
        }
        return Response.json({
          id: "resp_2",
          status: "completed",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "ok" }],
            },
          ],
        })
      },
    })

    const result = (await client.chat.completions.create({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
    })) as { choices: Array<{ message: { content: string } }> }

    expect(result.choices[0].message.content).toBe("ok")
    expect(persisted).toHaveLength(1)
  })
})
