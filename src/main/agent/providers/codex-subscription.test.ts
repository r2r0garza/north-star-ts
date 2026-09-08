import { describe, expect, it } from "vitest"
import {
  buildCodexSubscriptionRequest,
  completeCodexSubscriptionDeviceAuth,
  codexSubscriptionResponseToChat,
  buildCodexSubscriptionClient,
  preflightCodexSubscriptionBackend,
  redactCodexSubscriptionError,
  resolveCodexSubscriptionAuth,
  requestCodexSubscriptionDeviceCode,
} from "./codex-subscription"

function jwtWithExp(exp: number): string {
  const b64 = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${b64({ alg: "none" })}.${b64({ exp })}.sig`
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
