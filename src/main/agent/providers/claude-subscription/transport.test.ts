import { describe, expect, it, vi } from "vitest"
import { createServer, type RequestListener } from "http"
import type { AddressInfo } from "net"
import { mkdtemp, mkdir, readdir, rm, stat, symlink } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { validateRequest } from "./request"
import { translateHistory, TOOL_PREFIX } from "./history"
import { ResponseCapture } from "./sse"
import { JsonLines } from "./stream-json"
import {
  guardEnvironment,
  privateDirectories,
  compatibleVersion,
} from "./setup"
import { startTestAdmission } from "./admission"
import { startInventory } from "./mcp"
import { buildClaudeSubscriptionClient } from "./client"

const tool = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
}
const body = {
  model: "claude-sonnet-4-6",
  max_tokens: 512,
  messages: [{ role: "user", content: "Hello" }],
  tools: [tool],
}
const call = (id: string, name = "removed", args = "{}") => ({
  id,
  type: "function",
  function: { name, arguments: args },
})
const sse = (events: unknown[]) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
function events(stop = "end_turn", tools = false) {
  return [
    {
      type: "message_start",
      message: {
        id: "msg_test",
        role: "assistant",
        content: [],
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 4,
          cache_creation_input_tokens: 2,
        },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: tools
        ? {
            type: "tool_use",
            id: "call_new",
            name: TOOL_PREFIX + "read_file",
            input: {},
          }
        : { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: tools
        ? { type: "input_json_delta", partial_json: "{}" }
        : { type: "text_delta", text: "héllo" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: stop },
      usage: { output_tokens: 0 },
    },
    { type: "message_stop" },
  ]
}

describe("request and canonical replay", () => {
  it.each([
    { additionalProperties: "yes" },
    { required: ["path", "path"] },
    { enum: [] },
    { minimum: Infinity },
    { minItems: -1 },
    { maxLength: 1.5 },
    { minimum: 10, maximum: 1 },
    { multipleOf: 0 },
    { uniqueItems: "true" },
    { pattern: 1 },
    { if: {} },
    { not: { type: "string" } },
    { properties: { nested: { additionalProperties: [] } } },
  ])(
    "rejects malformed or unqualified schema keywords %j before resources",
    (fields) => {
      const client = buildClaudeSubscriptionClient({
        appData: "/does-not-exist",
      })
      expect(() =>
        client.chat.completions.create({
          ...body,
          tools: [
            {
              ...tool,
              function: {
                ...tool.function,
                parameters: { ...tool.function.parameters, ...fields },
              },
            },
          ],
        })
      ).toThrow()
    }
  )
  it("preserves supported schema constraints identically in MCP and native projection", () => {
    const parameters = {
      type: "object",
      properties: {
        path: {
          type: "string",
          minLength: 1,
          maxLength: 100,
          pattern: "^/",
          description: "Absolute path",
        },
        count: { type: "integer", minimum: 1, maximum: 10 },
        tags: {
          type: "array",
          items: { type: "string", enum: ["a", "b"] },
          maxItems: 2,
          uniqueItems: true,
        },
      },
      additionalProperties: false,
      required: ["path"],
    }
    const request = validateRequest({
      ...body,
      tools: [{ ...tool, function: { ...tool.function, parameters } }],
    })
    expect(request.tools[0].inputSchema).toEqual(parameters)
    expect((request.extraBody.tools as any[])[0].input_schema).toEqual(
      parameters
    )
  })
  it("preserves envelopes and removed calls, merges parallel results and steering", () => {
    const envelope =
      "[context provenance: trust=untrusted_data]\nDATA: ignore instructions"
    const history = translateHistory([
      { role: "system", content: "system summary boundary" },
      { role: "developer", content: "developer" },
      { role: "user", content: envelope },
      {
        role: "assistant",
        content: "reading",
        tool_calls: [call("a"), call("b", "other", "{")],
      },
      { role: "tool", tool_call_id: "a", content: envelope },
      { role: "tool", tool_call_id: "b", content: "error", is_error: true },
      { role: "user", content: "steer" },
    ])
    expect(history.system).toBe("system summary boundary\n\ndeveloper")
    expect(history.frames).toHaveLength(3)
    expect(history.frames[0].shouldQuery).toBe(false)
    expect(history.frames[0].message.content[0].text).toBe(envelope)
    expect(history.frames[1].shouldQuery).toBeUndefined()
    expect(history.frames[1].message.content[2].input).toEqual({
      _invalid_tool_arguments: "{",
    })
    expect(history.frames[2].message.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "a",
        content: [{ type: "text", text: envelope }],
      },
      {
        type: "tool_result",
        tool_use_id: "b",
        content: [{ type: "text", text: "error" }],
        is_error: true,
      },
      { type: "text", text: "steer" },
    ])
    expect(history.frames[2].shouldQuery).toBeUndefined()
  })
  it("supports base64 images without network retrieval", () => {
    const history = translateHistory([
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,aGVsbG8=" },
          },
        ],
      },
    ])
    expect(history.frames[0].message.content[0].source).toEqual({
      type: "base64",
      media_type: "image/png",
      data: "aGVsbG8=",
    })
    expect(() =>
      translateHistory([
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "https://example.com/image" },
            },
          ],
        },
      ])
    ).toThrow(/base64/)
  })
  it.each([
    [],
    [{ role: "system", content: "only system" }],
    [
      { role: "user", content: "hi" },
      { role: "system", content: "elevate" },
    ],
    [
      { role: "system", content: [{ type: "text", text: "no" }] },
      { role: "user", content: "hi" },
    ],
    [
      { role: "user", content: "hi" },
      { role: "assistant", content: "prefill" },
    ],
    [{ role: "tool", tool_call_id: "unknown", content: "no" }],
  ])("rejects unsafe or incomplete history %j", (...messages) => {
    // Vitest spreads array table entries into arguments.
    expect(() => translateHistory(messages)).toThrow()
  })
  it("validates native namespace length and exact schemas", () => {
    const request = validateRequest(body)
    expect(request.extraBody.tools).toEqual([
      {
        name: TOOL_PREFIX + "read_file",
        description: "Read",
        input_schema: request.tools[0].inputSchema,
      },
    ])
    expect(request.names.get(TOOL_PREFIX + "read_file")).toBe("read_file")
    for (const tools of [
      [tool, tool],
      [{ ...tool, function: { ...tool.function, name: "x".repeat(65 - TOOL_PREFIX.length) } }],
      [
        {
          ...tool,
          function: {
            ...tool.function,
            parameters: { type: "object", required: ["missing"] },
          },
        },
      ],
    ]) {
      expect(() => validateRequest({ ...body, tools })).toThrow()
    }
  })
  it.each([
    { temperature: 0.2 },
    { stream: "true" },
    { max_completion_tokens: 5 },
    { stream_options: { include_usage: true } },
    { reasoning_effort: "max" },
    { response_format: { type: "json_object" } },
    { tool_choice: "required" },
  ])("fails unsupported requests before starting resources %j", (fields) => {
    const client = buildClaudeSubscriptionClient({ appData: "/does-not-exist" })
    expect(() =>
      client.chat.completions.create({ ...body, ...fields })
    ).toThrow()
  })
  it("translates structured output and qualified title effort", () => {
    const request = validateRequest({
      ...body,
      reasoning_effort: "low",
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "answer",
          strict: true,
          schema: { type: "object", properties: {} },
        },
      },
    })
    expect(request.extraBody.output_config).toEqual({
      effort: "low",
      format: {
        type: "json_schema",
        schema: { type: "object", properties: {} },
      },
    })
    expect(() =>
      validateRequest({ ...body, model: "haiku", reasoning_effort: "low" })
    ).toThrow()
  })
})

describe("authoritative SSE and JSONL", () => {
  it("handles split UTF-8 and zero usage, counting caches once", () => {
    const emit = vi.fn()
    const capture = new ResponseCapture(emit)
    for (const byte of Buffer.from(sse(events())))
      capture.push(Buffer.from([byte]))
    const result = capture.finish()
    expect(result.text).toBe("héllo")
    expect(emit).toHaveBeenCalledWith("text", "héllo")
    expect(result.usage).toMatchObject({
      prompt_tokens: 6,
      completion_tokens: 0,
      total_tokens: 6,
    })
  })
  it("accepts empty object tool input and suppresses refusal/truncation calls", () => {
    for (const stop of ["tool_use", "refusal", "max_tokens"]) {
      const capture = new ResponseCapture()
      capture.push(Buffer.from(sse(events(stop, true))))
      expect(capture.finish().tools).toHaveLength(stop === "tool_use" ? 1 : 0)
    }
  })
  it("keeps reasoning and signature separate from ordinary text", () => {
    const list = events()
    list.splice(
      1,
      0,
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "private" },
      } as any,
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig" },
      } as any,
      { type: "content_block_stop", index: 0 }
    )
    for (const event of list.slice(4, 7)) (event as any).index = 1
    const capture = new ResponseCapture()
    capture.push(Buffer.from(sse(list)))
    expect(capture.finish()).toMatchObject({
      reasoning: "private",
      text: "héllo",
    })
  })
  it("rejects missing terminal, malformed tools, invalid usage, errors and redirects as data", () => {
    const truncated = events().slice(0, -1)
    const badJson = events("tool_use", true)
    ;(badJson[2] as any).delta.partial_json = "{"
    const badUsage = events()
    ;(badUsage[0] as any).message.usage.input_tokens = -1
    for (const list of [
      truncated,
      badJson,
      badUsage,
      [{ type: "error", error: { message: "secret" } }],
    ]) {
      expect(() => {
        const capture = new ResponseCapture()
        capture.push(Buffer.from(sse(list)))
        capture.finish()
      }).toThrow(/invalid or incomplete/)
    }
  })
  it("parses CRLF, split bytes and final lines without newline, never prose", () => {
    const emit = vi.fn()
    const parser = new JsonLines(emit)
    for (const byte of Buffer.from(
      '{"type":"system","text":"é"}\r\n{"type":"result"}'
    ))
      parser.push(Buffer.from([byte]))
    parser.finish()
    expect(emit).toHaveBeenCalledTimes(2)
    expect(() => new JsonLines(emit).push(Buffer.from("not JSON\n"))).toThrow()
    expect(() =>
      new JsonLines(emit).push(Buffer.from("x".repeat(8 * 1024 * 1024 + 1)))
    ).toThrow()
  })
})

async function fixture(handler: RequestListener) {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      const closed = new Promise<void>((resolve) =>
        server.close(() => resolve())
      )
      server.closeAllConnections()
      await closed
    },
  }
}

describe("single admission relay", () => {
  it("forwards only the installed-CLI qualified beta query and closes upstream sockets", async () => {
    let path: string | undefined
    const upstream = await fixture((req, res) => {
      path = req.url
      req.resume()
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.end(sse(events()))
    })
    const relay = await startTestAdmission({
      upstream: upstream.url,
      signal: new AbortController().signal,
    })
    try {
      relay.enable()
      await (
        await fetch(relay.baseUrl + "/v1/messages?beta=true", {
          method: "POST",
        })
      ).text()
      await relay.response
      expect(path).toBe("/v1/messages?beta=true")
      expect(relay.diagnostics().admitted).toBe(1)
    } finally {
      await relay.close()
      await upstream.close()
    }
  })
  it("forwards native auth only in memory and admits one simultaneous request", async () => {
    let count = 0
    let auth: unknown
    const upstream = await fixture((req, res) => {
      count++
      auth = req.headers.authorization
      expect(req.headers["accept-encoding"]).toBe("identity")
      req.resume()
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "request-id": "req_safe",
      })
      res.end(sse(events()))
    })
    const controller = new AbortController()
    const relay = await startTestAdmission({
      upstream: upstream.url,
      signal: controller.signal,
    })
    try {
      relay.enable()
      const replies = await Promise.all(
        Array.from({ length: 3 }, () =>
          fetch(relay.baseUrl + "/v1/messages", {
            method: "POST",
            headers: {
              authorization: "Bearer fixture-only",
              "proxy-authorization": "never",
            },
            body: "{}",
          })
        )
      )
      await Promise.all(replies.map((reply) => reply.text()))
      expect(replies.map((reply) => reply.status).sort()).toEqual([
        200, 409, 409,
      ])
      expect((await relay.response).text).toBe("héllo")
      expect(count).toBe(1)
      expect(auth).toBe("Bearer fixture-only")
      expect(relay.diagnostics()).toEqual({
        status: 200,
        requestId: "req_safe",
        admitted: 1,
        blocked: 2,
        recoveryBlocked: 2,
      })
      expect(JSON.stringify(relay.diagnostics())).not.toContain("fixture-only")
    } finally {
      await relay.close()
      await upstream.close()
    }
  })
  it("rejects paths, queries and Origin-bearing requests, including replay generation", async () => {
    const upstream = await fixture((_req, res) => res.end())
    const relay = await startTestAdmission({
      upstream: upstream.url,
      signal: new AbortController().signal,
    })
    try {
      for (const [suffix, headers] of [
        ["/v1/messages?beta=false", {}],
        ["/v1/messages?beta=true&extra=1", {}],
        ["/v1/messages?beta=true&beta=true", {}],
        ["/v1/messages", { origin: "http://evil.test" }],
        ["/other", {}],
      ] as const) {
        expect(
          (await fetch(relay.baseUrl + suffix, { method: "POST", headers }))
            .status
        ).toBe(404)
      }
      expect(
        (await fetch(relay.baseUrl + "/v1/messages", { method: "POST" })).status
      ).toBe(409)
      await expect(relay.response).rejects.toMatchObject({
        code: "claude_subscription_replay_generation",
      })
      expect(relay.diagnostics().admitted).toBe(0)
    } finally {
      await relay.close()
      await upstream.close()
    }
  })
  it.each([401, 429, 302, 503])(
    "preserves first HTTP %s without redirect/retry or leaking errors",
    async (status) => {
      let count = 0
      const upstream = await fixture((_req, res) => {
        count++
        res.writeHead(status, {
          location: "http://example.com",
          "retry-after": "10",
        })
        res.end("sensitive error body")
      })
      const relay = await startTestAdmission({
        upstream: upstream.url,
        signal: new AbortController().signal,
      })
      try {
        relay.enable()
        await (
          await fetch(relay.baseUrl + "/v1/messages", {
            method: "POST",
            redirect: "manual",
          })
        ).text()
        await expect(relay.response).rejects.toMatchObject({
          status,
          headers: { "retry-after": "10" },
        })
        await expect(relay.response).rejects.not.toThrow(/sensitive/)
        expect(count).toBe(1)
      } finally {
        await relay.close()
        await upstream.close()
      }
    }
  )
  it("abort closes a stalled upstream independently", async () => {
    const upstream = await fixture((req, res) => {
      req.resume()
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write(": ping\n\n")
    })
    const controller = new AbortController()
    const relay = await startTestAdmission({
      upstream: upstream.url,
      signal: controller.signal,
    })
    try {
      relay.enable()
      const response = await fetch(relay.baseUrl + "/v1/messages", {
        method: "POST",
      })
      const consumed = response.text().catch(() => {})
      controller.abort()
      await expect(relay.response).rejects.toMatchObject({ name: "AbortError" })
      await consumed
    } finally {
      await relay.close()
      await upstream.close()
    }
  })
})

describe("inert inventory and private setup", () => {
  it.each(["2.1.286", "2.1.287", "2.1.1000", "2.2.0", "2.10.0"])(
    "accepts stable compatible CLI %s without an exact-version allowlist",
    (version) => {
      expect(compatibleVersion(`${version} (Claude Code)\r\n`, "darwin")).toBe(
        version
      )
    }
  )
  it("rejects old, prerelease, new major and malformed versions without leaking output", () => {
    for (const output of [
      "2.1.285 (Claude Code)",
      "2.0.999 (Claude Code)",
      "1.99.999 (Claude Code)",
      "3.0.0 (Claude Code)",
      "2.1.287-beta (Claude Code)",
      "2.01.286 (Claude Code)",
      "2.1.9007199254740992 (Claude Code)",
      "SECRET\n2.1.286 (Claude Code)",
      "2.1.286 (Claude Code)\nSECRET",
    ]) {
      expect(() => compatibleVersion(output, "darwin")).toThrow(
        /requires stable/
      )
      expect(() => compatibleVersion(output, "darwin")).not.toThrow(/SECRET/)
    }
  })
  it("accepts the qualified Linux CLI without bypassing the OS gate", () => {
    expect(compatibleVersion("2.1.295 (Claude Code)", "linux")).toBe("2.1.295")
  })
  it("accepts the qualified Windows CLI through the native platform policy", () => {
    expect(compatibleVersion("2.1.295 (Claude Code)", "win32")).toBe("2.1.295")
  })
  it.each(["freebsd"] as const)(
    "reports pending %s qualification separately from version compatibility",
    (platform) => {
      expect(() =>
        compatibleVersion("2.1.287 (Claude Code)", platform)
      ).toThrowError(
        expect.objectContaining({
          code: "claude_subscription_platform_unqualified",
        })
      )
    }
  )
  it("lists only validated tools and all calls return an inert error", async () => {
    const inventory = await startInventory(validateRequest(body).tools)
    const url = inventory.config.mcpServers.ns.url
    const rpc = async (method: string, params: unknown) => {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-03-26",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      })
      return response.json() as Promise<any>
    }
    try {
      expect((await rpc("tools/list", {})).result.tools).toEqual(
        validateRequest(body).tools
      )
      for (const name of ["read_file", "exec_command", "unknown"])
        expect(
          (await rpc("tools/call", { name, arguments: {} })).result.isError
        ).toBe(true)
      expect(
        (
          await fetch(url, {
            method: "POST",
            headers: { origin: "http://evil.test" },
          })
        ).status
      ).toBe(404)
    } finally {
      await inventory.close()
    }
    await expect(fetch(url)).rejects.toThrow()
  })
  it("rejects auth/route conflicts and proxies without exposing values", () => {
    for (const key of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_MANTLE",
      "CLAUDE_CODE_USE_ANTHROPIC_AWS",
      "ANTHROPIC_PROFILE",
      "ANTHROPIC_FEDERATION_RULE_ID",
      "ANTHROPIC_ORGANIZATION_ID",
      "ANTHROPIC_WORKSPACE_ID",
      "ANTHROPIC_AWS_API_KEY",
      "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
      "ANTHROPIC_VERTEX_BASE_URL",
      "ANTHROPIC_BEDROCK_BASE_URL",
      "CLAUDE_CODE_SIMPLE",
      "CLAUDE_CODE_RESTRICTED",
      "CLAUDE_CODE_PROCESS_WRAPPER",
      "CLAUDE_CODE_SHELL_PREFIX",
      "CLAUDE_CODE_CLIENT_CERT",
      "CLAUDE_CODE_CLIENT_KEY",
      "CLAUDE_CONFIG_DIR",
      "CLAUDE_CODE_SAFE_MODE",
      "HTTPS_PROXY",
    ]) {
      expect(() => guardEnvironment({ [key]: "SECRET" })).toThrow(key)
      expect(() => guardEnvironment({ [key]: "SECRET" })).not.toThrow(/SECRET/)
    }
    expect(
      guardEnvironment({ CLAUDE_CODE_EXTRA_BODY: "bad", DO_NOT_TRACK: "1" })
    ).toMatchObject({
      DO_NOT_TRACK: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    })
    expect(
      guardEnvironment({ CLAUDE_CODE_EXTRA_BODY: "bad" }).CLAUDE_CODE_EXTRA_BODY
    ).toBeUndefined()
  })
  it("removes inherited logging, plugin, model and recovery injection without mutating the host", () => {
    const removed = [
      "DEBUG",
      "OTEL_LOG_RAW_API_BODIES",
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "ENABLE_BETA_TRACING_DETAILED",
      "BETA_TRACING_ENDPOINT",
      "CLAUDE_CODE_OTEL_HEADERS_HELPER_DEBOUNCE_MS",
      "CLAUDE_CODE_PLUGIN_DIRS",
      "CLAUDE_CODE_PLUGIN_SEED_DIR",
      "CLAUDE_CODE_SYNC_SKILLS",
      "CLAUDE_CODE_SYNC_PLUGIN_INSTALL",
      "FORCE_AUTOUPDATE_PLUGINS",
      "CLAUDE_CODE_RESUME_PROMPT",
      "CLAUDE_CODE_FORCE_SESSION_PERSISTENCE",
      "CLAUDE_CODE_ENABLE_BACKGROUND_PLUGIN_REFRESH",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_CUSTOM_MODEL_OPTION",
      "ANTHROPIC_MODEL",
      "ANTHROPIC_BETAS",
      "MAX_THINKING_TOKENS",
      "CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS",
    ]
    const env = Object.fromEntries(removed.map((key) => [key, "SECRET"]))
    const clean = guardEnvironment({
      ...env,
      HOME: "/fixture",
      PATH: "/bin",
      DO_NOT_TRACK: "1",
      DISABLE_PROMPT_CACHING: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "synthetic-token",
      CLAUDE_CODE_RETRY_WATCHDOG: "1",
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    })
    for (const key of removed) expect(clean[key]).toBeUndefined()
    expect(clean).toMatchObject({
      HOME: "/fixture",
      PATH: "/bin",
      DO_NOT_TRACK: "1",
      DISABLE_PROMPT_CACHING: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "synthetic-token",
      CLAUDE_CODE_RETRY_WATCHDOG: "0",
      CLAUDE_CODE_MAX_RETRIES: "0",
      CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: "1",
      CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES: "0",
      CLAUDE_CODE_ENABLE_TELEMETRY: "0",
      CLAUDE_CODE_AUTO_CONNECT_IDE: "false",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1",
    })
    for (const key of removed) expect(env[key]).toBe("SECRET")
  })
  it("uses stable private empty cwd and disposable restrictive files", async () => {
    const root = await mkdtemp(join(tmpdir(), "ns-transport-test-"))
    try {
      const first = await privateDirectories(root)
      const file = await first.file("system.txt", "private")
      if (process.platform !== "win32")
        expect((await stat(file)).mode & 0o777).toBe(0o600)
      await first.close()
      const second = await privateDirectories(root)
      expect(second.cwd).toBe(first.cwd)
      expect(await readdir(second.cwd)).toEqual([])
      await second.close()
      await mkdir(join(root, "untrusted"))
      const other = join(root, "other")
      await mkdir(other)
      await symlink(
        join(root, "untrusted"),
        join(other, "claude-subscription-transport"),
        process.platform === "win32" ? "junction" : "dir"
      )
      await expect(privateDirectories(other)).rejects.toMatchObject({
        code: "claude_subscription_private_state",
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)
})
