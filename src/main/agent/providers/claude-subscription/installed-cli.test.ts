import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createServer } from "http"
import type { AddressInfo } from "net"
import { mkdtemp, mkdir, readdir, rm, writeFile, access } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"

const fixture = vi.hoisted(() => ({
  origin: "",
  home: "",
  inherited: {} as NodeJS.ProcessEnv,
  relay: undefined as any,
}))
vi.mock("../../env/host-cli-env", () => ({
  hostCliEnv: async () => ({
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    USERPROFILE: fixture.home,
    APPDATA: join(fixture.home, "AppData", "Roaming"),
    LOCALAPPDATA: join(fixture.home, "AppData", "Local"),
    HOME: fixture.home,
    ...fixture.inherited,
  }),
}))
vi.mock("./auth-policy", () => ({ verifyPersonalSubscription: vi.fn() }))
vi.mock("./setup", async (original) => {
  const actual = await original<typeof import("./setup")>()
  return {
    ...actual,
    guardEnvironment: (env: NodeJS.ProcessEnv) => ({
      ...actual.guardEnvironment(env),
      ANTHROPIC_API_KEY: "synthetic-not-a-real-key",
      CLAUDE_CONFIG_DIR: join(fixture.home, ".claude"),
    }),
  }
})
vi.mock("./admission", async (original) => {
  const actual = await original<typeof import("./admission")>()
  return {
    ...actual,
    startAdmission: async (options: any) => {
      fixture.relay = await actual.startTestAdmission({
        ...options,
        upstream: fixture.origin,
        readIdleMs: 1000,
      })
      return fixture.relay
    },
  }
})
import {
  buildClaudeSubscriptionClient,
  shutdownClaudeSubscription,
} from "./client"

const enabled = process.env.NS_QUALIFY_INSTALLED_CLAUDE === "1"
let root: string
let server: ReturnType<typeof createServer>
let scenario: string
let requests: number
let capturedBody: any
let sockets = 0
const body = {
  model: "claude-sonnet-4-6",
  max_tokens: 512,
  stream: true,
  messages: [
    {
      role: "user",
      content: "Synthetic loopback fixture. Return the fixture response.",
    },
  ],
  tools: [
    {
      type: "function",
      function: {
        name: "probe",
        description: "Inert fixture",
        parameters: { type: "object", properties: {} },
      },
    },
  ],
}

beforeEach(async (context) => {
  if (!enabled) return
  scenario = context.task.name
  requests = 0
  capturedBody = undefined
  sockets = 0
  fixture.relay = undefined
  fixture.inherited = {}
  root = await mkdtemp(join(tmpdir(), "ns-installed-"))
  fixture.home = join(root, "home")
  await mkdir(fixture.home)
  server = createServer(async (req, res) => {
    requests++
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    capturedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    if (scenario.includes("HTTP")) {
      res.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "10",
      })
      res.end(
        JSON.stringify({
          type: "error",
          error: { type: "rate_limit_error", message: "synthetic fixture" },
        })
      )
      return
    }
    res.writeHead(200, { "content-type": "text/event-stream" })
    const tool = scenario.includes("tool")
    const events: any[] = [
      {
        type: "message_start",
        message: {
          id: "msg_synthetic",
          type: "message",
          role: "assistant",
          model: body.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: tool
          ? {
              type: "tool_use",
              id: "tool_fixture",
              name: scenario.includes("external")
                ? "mcp__ado__testplan_show_test_results_from_build_id"
                : "mcp__ns__probe",
              input: {},
            }
          : { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: tool
          ? { type: "input_json_delta", partial_json: "{}" }
          : {
              type: "text_delta",
              text: scenario.includes("whitespace")
                ? "synthetic response\n"
                : "synthetic response",
            },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: {
          stop_reason: tool
            ? "tool_use"
            : scenario.includes("pause_turn")
              ? "pause_turn"
              : scenario.includes("output limit")
                ? "max_tokens"
                : "end_turn",
          stop_sequence: null,
        },
        usage: { output_tokens: 2 },
      },
      { type: "message_stop" },
    ]
    if (scenario.includes("text plus tool")) {
      events.splice(
        1,
        0,
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "I will inspect the selected container through the host tool.",
          },
        },
        { type: "content_block_stop", index: 0 }
      )
      for (const event of events.slice(4, 7)) event.index = 1
    }
    const wire = (list: any[]) =>
      list
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
        )
        .join("")
    if (
      scenario.includes("stall") ||
      scenario.includes("cancel") ||
      scenario.includes("return")
    ) {
      res.write(wire(events.slice(0, 3)))
      return
    }
    if (scenario.includes("truncated")) {
      res.end(wire(events.slice(0, 3)))
      return
    }
    if (scenario.includes("empty recovery")) {
      events[2].delta.text = ""
      if (scenario.includes("max_tokens"))
        events[4].delta.stop_reason = "max_tokens"
    }
    if (scenario.includes("recovery tool"))
      events[1].content_block.name = "mcp__ns__missing_fixture"
    if (scenario.includes("truncated text")) {
      res.end(wire(events.slice(0, -1)))
      return
    }
    res.end(wire(events))
  })
  server.on("connection", (socket) => {
    sockets++
    socket.once("close", () => sockets--)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  fixture.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(async () => {
  if (!enabled) return
  await fixture.relay?.close()
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: process.platform === "win32" ? 10 : 0,
    retryDelay: 100,
  })
})
async function clean() {
  expect(await readdir(join(root, "claude-subscription-transport"))).toEqual([
    "cwd",
  ])
  await vi.waitFor(() => expect(sockets).toBe(0))
}
async function consume(signal?: AbortSignal) {
  const stream: any = await buildClaudeSubscriptionClient({
    appData: root,
  }).chat.completions.create(body, undefined, { signal })
  const chunks: any[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe.skipIf(!enabled)(
  "installed Claude synthetic transport qualification",
  () => {
    it("official auth metadata rejects synthetic API-key authentication", async () => {
      const { verifyPersonalSubscription } =
        await vi.importActual<typeof import("./auth-policy")>("./auth-policy")
      const { resolveExecutable } = await import("./setup")
      const env = {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        USERPROFILE: fixture.home,
        APPDATA: join(fixture.home, "AppData", "Roaming"),
        LOCALAPPDATA: join(fixture.home, "AppData", "Local"),
        HOME: fixture.home,
        CLAUDE_CONFIG_DIR: join(fixture.home, ".claude"),
        ANTHROPIC_API_KEY: "synthetic-not-a-real-key",
        DISABLE_TELEMETRY: "1",
        DISABLE_ERROR_REPORTING: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_AUTOUPDATER: "1",
      }
      await expect(
        verifyPersonalSubscription(
          await resolveExecutable(env),
          root,
          env,
          new AbortController().signal
        )
      ).rejects.toMatchObject({
        code: "claude_subscription_account_unqualified",
      })
      expect(requests).toBe(0)
      expect(fixture.relay).toBeUndefined()
    }, 10000)
    it.each(["generation", "discovery"])(
      "rejects cached remote policy before %s startup",
      async (operation) => {
        await mkdir(join(fixture.home, ".claude"))
        await writeFile(
          join(fixture.home, ".claude", "remote-settings.json"),
          JSON.stringify({ env: { DEBUG: "1" } })
        )
        const client = buildClaudeSubscriptionClient({ appData: root })
        await expect(
          operation === "generation"
            ? client.chat.completions.create({ ...body, stream: false })
            : client.models.list()
        ).rejects.toMatchObject({ code: "claude_subscription_managed_policy" })
        expect(fixture.relay).toBeUndefined()
        expect(requests).toBe(0)
        await clean()
      },
      60000
    )
    it("discovers models with zero upstream generation", async () => {
      const result = await buildClaudeSubscriptionClient({
        appData: root,
      }).models.list()
      expect(result?.data?.length).toBeGreaterThan(0)
      expect(requests).toBe(0)
      expect(fixture.relay.diagnostics().admitted).toBe(0)
      await clean()
    }, 60000)
    it.each([false, true])(
      "historical replay with parallel results: %s",
      async (withTools) => {
        const messages: any[] = [
          { role: "user", content: "historical question" },
          { role: "assistant", content: "historical answer" },
        ]
        if (withTools) {
          messages.push(
            { role: "user", content: "historical probes" },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "past_a",
                  type: "function",
                  function: { name: "probe", arguments: "{}" },
                },
                {
                  id: "past_b",
                  type: "function",
                  function: {
                    name: "removed_probe",
                    arguments: '{"path":"fixture"}',
                  },
                },
              ],
            },
            {
              role: "tool",
              tool_call_id: "past_a",
              content: "historical result a",
            },
            {
              role: "tool",
              tool_call_id: "past_b",
              content: "historical result b",
            }
          )
        }
        messages.push({ role: "user", content: "current question" })
        const result: any = await buildClaudeSubscriptionClient({
          appData: root,
        }).chat.completions.create({
          ...body,
          stream: false,
          messages,
        })
        expect(result.choices[0].message.content).toBe("synthetic response")
        expect(requests).toBe(1)
        const wire = JSON.stringify(capturedBody.messages)
        for (const text of [
          "historical question",
          "historical answer",
          "current question",
        ])
          expect(wire).toContain(text)
        if (withTools) {
          for (const text of [
            "past_a",
            "past_b",
            "historical result a",
            "historical result b",
          ])
            expect(wire).toContain(text)
          const results = capturedBody.messages.flatMap((message: any) =>
            Array.isArray(message.content)
              ? message.content.filter(
                  (block: any) => block.type === "tool_result"
                )
              : []
          )
          expect(results.map((block: any) => block.tool_use_id)).toEqual([
            "past_a",
            "past_b",
          ])
        }
        expect(fixture.relay.diagnostics().recoveryBlocked).toBe(0)
        await clean()
      },
      60000
    )
    it("isolates inherited logging and plugin settings", async () => {
      const plugin = join(root, "inherited-plugin")
      const marker = join(root, "inherited-hook-ran")
      await mkdir(join(plugin, ".claude-plugin"), { recursive: true })
      await mkdir(join(plugin, "hooks"))
      await writeFile(
        join(plugin, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "inherited-fixture", version: "1.0.0" })
      )
      const hook = join(root, "marker.cjs")
      await writeFile(
        hook,
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "fixture")`
      )
      await writeFile(
        join(plugin, "hooks", "hooks.json"),
        JSON.stringify({
          hooks: {
            SessionStart: [
              {
                hooks: [
                  {
                    type: "command",
                    command: `"${process.execPath}" "${hook}"`,
                  },
                ],
              },
            ],
          },
        })
      )
      const debug = join(root, "inherited-debug.txt")
      const bodies = join(root, "inherited-bodies")
      fixture.inherited = {
        DEBUG: "1",
        CLAUDE_CODE_DEBUG_LOGS_DIR: debug,
        CLAUDE_CODE_PLUGIN_DIRS: plugin,
        CLAUDE_CODE_SYNC_PLUGIN_INSTALL: "1",
        CLAUDE_CODE_ENABLE_TELEMETRY: "1",
        OTEL_LOG_RAW_API_BODIES: `file:${bodies}`,
        OTEL_EXPORTER_OTLP_ENDPOINT: fixture.origin + "/otel",
        CLAUDE_CODE_RETRY_WATCHDOG: "1",
      }
      await consume()
      expect(requests).toBe(1)
      for (const path of [marker, debug, bodies])
        await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" })
      await clean()
    }, 60000)
    it.each(["haiku", "claude-haiku-4-5", "claude-sonnet-4-6"])(
      "disables native thinking for sub-minimum auxiliary output caps on %s",
      async (model) => {
        const result: any = await buildClaudeSubscriptionClient({
          appData: root,
        }).chat.completions.create({
          ...body,
          model,
          max_tokens: 256,
          stream: false,
          tools: [],
        })
        expect(result.choices[0].message.content).toBe("synthetic response")
        expect(capturedBody.max_tokens).toBe(256)
        // Newer native alias targets omit thinking instead of sending disabled.
        expect(capturedBody.thinking?.type ?? "disabled").toBe("disabled")
        expect(requests).toBe(1)
        await clean()
      },
      60000
    )
    it.each(["haiku", "sonnet", "opus"])(
      "resolves %s natively with context above the old alias cap",
      async (model) => {
        const marker = "alias context qualification " + "x".repeat(135000)
        const result: any = await buildClaudeSubscriptionClient({
          appData: root,
        }).chat.completions.create({
          ...body,
          model,
          max_tokens: 2048,
          stream: false,
          tools: [],
          messages: [{ role: "user", content: marker }],
        })
        expect(result.choices[0].message.content).toBe("synthetic response")
        expect(capturedBody.model).toMatch(new RegExp(`^claude-${model}-`))
        expect(JSON.stringify(capturedBody.messages)).toContain(marker)
        expect(requests).toBe(1)
        await clean()
      },
      60000
    )
    it("preserves text plus tool blocks at the host-owned tool boundary", async () => {
      const result: any = await buildClaudeSubscriptionClient({
        appData: root,
      }).chat.completions.create({ ...body, stream: false })
      expect(result.choices[0].message.content).toBe(
        "I will inspect the selected container through the host tool."
      )
      expect(result.choices[0].message.tool_calls[0].function.name).toBe(
        "probe"
      )
      expect(requests).toBe(1)
      await clean()
    }, 60000)
    it("preserves native adaptive reasoning for ordinary output caps", async () => {
      await buildClaudeSubscriptionClient({
        appData: root,
      }).chat.completions.create({
        ...body,
        max_tokens: 2048,
        stream: false,
        tools: [],
      })
      expect(capturedBody.thinking).toMatchObject({ type: "adaptive" })
      expect(requests).toBe(1)
      await clean()
    }, 60000)
    it("reconstructs user and historical tool-result base64 images", async () => {
      const image = {
        type: "image_url",
        image_url: {
          url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG1sAAAAASUVORK5CYII=",
        },
      }
      await buildClaudeSubscriptionClient({
        appData: root,
      }).chat.completions.create({
        ...body,
        stream: false,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Original image" }, image],
          },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "past_image",
                type: "function",
                function: { name: "probe", arguments: "{}" },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "past_image",
            content: [{ type: "text", text: "Historical tool image" }, image],
          },
          { role: "user", content: "Reconstruct the available media" },
        ],
      })
      const blocks = capturedBody.messages.flatMap((m: any) => m.content)
      expect(blocks.find((b: any) => b.type === "image").source).toMatchObject({
        type: "base64",
        media_type: "image/png",
      })
      const result = blocks.find((b: any) => b.type === "tool_result")
      expect(result.tool_use_id).toBe("past_image")
      expect(
        result.content.find((b: any) => b.type === "image").source.data
      ).toBe(image.image_url.url.split(",")[1])
      expect(requests).toBe(1)
      await clean()
    }, 60000)
    it("auxiliary output limit", async () => {
      await consume()
      expect(requests).toBe(1)
      await clean()
    }, 60000)
    it("preserves response whitespace despite native final-result presentation", async () => {
      const chunks = await consume()
      expect(
        chunks.map((chunk) => chunk.choices[0].delta.content ?? "").join("")
      ).toBe("synthetic response\n")
      expect(requests).toBe(1)
      await clean()
    }, 60000)
    it("text success", async () => {
      const chunks = await consume()
      expect(
        chunks.map((chunk) => chunk.choices[0].delta.content ?? "").join("")
      ).toBe("synthetic response")
      expect(requests).toBe(1)
      await clean()
    }, 60000)
    it("external tool inventory, canonical decoding and historical replay", async () => {
      const name = "mcp__ado__testplan_show_test_results_from_build_id"
      const request = {
        ...body,
        stream: false,
        tools: [
          ...body.tools,
          { ...body.tools[0], function: { ...body.tools[0].function, name } },
        ],
      }
      const client = buildClaudeSubscriptionClient({ appData: root })
      const first: any = await client.chat.completions.create(request)
      expect(first.choices[0].message.tool_calls[0].function.name).toBe(name)
      expect(capturedBody.tools.map((tool: any) => tool.name)).toEqual([
        "mcp__ns__probe",
        name,
      ])
      await clean()
      const second: any = await client.chat.completions.create({
        ...request,
        messages: [
          ...body.messages,
          {
            role: "assistant",
            content: null,
            tool_calls: first.choices[0].message.tool_calls,
          },
          {
            role: "tool",
            tool_call_id: "tool_fixture",
            content: "External host result",
          },
        ],
      })
      expect(second.choices[0].message.tool_calls[0].function.name).toBe(name)
      expect(JSON.stringify(capturedBody.messages)).toContain(name)
      expect(JSON.stringify(capturedBody.messages)).toContain(
        "External host result"
      )
      expect(requests).toBe(2)
      await clean()
    }, 60000)
    it("tool max-turn boundary", async () => {
      const chunks = await consume()
      expect(chunks.at(-1).choices[0].delta.tool_calls[0].function.name).toBe(
        "probe"
      )
      expect(requests).toBe(1)
      await clean()
    }, 60000)
    it.each(["truncated tool", "stall"])(
      "%s",
      async () => {
        await expect(consume()).rejects.toThrow()
        expect(requests).toBe(1)
        await clean()
      },
      60000
    )
    it.each(["cancel", "iterator return"])(
      "%s",
      async (mode) => {
        const controller = new AbortController()
        const stream: any = await buildClaudeSubscriptionClient({
          appData: root,
        }).chat.completions.create(body, undefined, {
          signal: controller.signal,
        })
        await stream.next()
        const pending = stream.next()
        if (mode === "cancel") {
          const rejected = expect(pending).rejects.toMatchObject({
            name: "AbortError",
          })
          controller.abort()
          await rejected
        } else {
          await stream.return()
          expect(await pending).toMatchObject({ done: true })
        }
        await vi.waitFor(clean)
        expect(requests).toBe(1)
      },
      60000
    )
    it("shutdown cancel", async () => {
      const stream: any = await buildClaudeSubscriptionClient({
        appData: root,
      }).chat.completions.create(body)
      await stream.next()
      const pending = expect(stream.next()).rejects.toMatchObject({
        name: "AbortError",
      })
      shutdownClaudeSubscription()
      await pending
      await vi.waitFor(clean, { timeout: 10000 })
      expect(requests).toBe(1)
    }, 60000)
    it("first HTTP status wins over native recovery", async () => {
      fixture.inherited = {
        CLAUDE_CODE_RETRY_WATCHDOG: "1",
        CLAUDE_CODE_MAX_RETRIES: "15",
        CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES: "10",
      }
      await expect(consume()).rejects.toMatchObject({
        status: 429,
        headers: { "retry-after": "10" },
      })
      expect(requests).toBe(1)
      await clean()
    }, 60000)
    it("truncated text", async () => {
      await expect(consume()).rejects.toThrow()
      expect(requests).toBe(1)
      await clean()
    }, 60000)
    it("unknown recovery tool remains non-executable", async () => {
      await expect(consume()).rejects.toMatchObject({
        code: "claude_subscription_protocol",
      })
      expect(requests).toBe(1)
      await clean()
    }, 60000)
    it.each([
      ["end_turn", true],
      ["max_tokens", true],
      ["end_turn", false],
      ["max_tokens", false],
    ])(
      "empty recovery %s stream=%s",
      async (_stop, streamMode) => {
        let error: any
        const chunks: any[] = []
        try {
          const stream: any = await buildClaudeSubscriptionClient({
            appData: root,
          }).chat.completions.create({ ...body, stream: streamMode })
          if (streamMode) for await (const chunk of stream) chunks.push(chunk)
        } catch (caught) {
          error = caught
        }
        expect(error).toMatchObject({ code: "claude_subscription_protocol" })
        expect(requests).toBe(1)
        expect(
          chunks.some((chunk) => chunk.choices[0].delta.tool_calls?.length)
        ).toBe(false)
        expect(fixture.relay.diagnostics().recoveryBlocked).toBe(1)
        await clean()
      },
      60000
    )
    it("pause_turn does not prove denied recovery", async () => {
      const chunks = await consume()
      expect(chunks.at(-1).choices[0].finish_reason).toBe("stop")
      expect(fixture.relay.diagnostics().recoveryBlocked).toBe(0)
      expect(requests).toBe(1)
      await clean()
    }, 60000)
  }
)
