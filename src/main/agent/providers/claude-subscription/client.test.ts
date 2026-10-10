import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createServer } from "http"
import type { AddressInfo } from "net"
import { mkdtemp, readdir, readFile, rm } from "fs/promises"
import { tmpdir } from "os"
import { join, resolve } from "path"

const state = vi.hoisted(() => ({
  origin: "",
  mode: "",
  version: "",
  spawns: 0,
  relay: undefined as any,
  settings: undefined as any,
}))
vi.mock("child_process", async (original) => {
  const actual = await original<typeof import("child_process")>()
  return {
    ...actual,
    spawn: (_executable: string, _args: string[], options: any) => {
      if (
        _executable.toLowerCase().endsWith("powershell.exe") ||
        _executable === "taskkill"
      )
        return actual.spawn(_executable, _args, options)
      if (_args[0] === "--version")
        return actual.spawn(
          process.execPath,
          [
            "-e",
            state.mode === "bad-version"
              ? "console.log('0.0.1 (Claude Code)')"
              : `console.log(${JSON.stringify(`${state.version} (Claude Code)`)})`,
          ],
          options
        )
      state.spawns++
      state.settings = readFile(
        _args[_args.indexOf("--settings") + 1],
        "utf8"
      ).then(JSON.parse)
      return actual.spawn(
        process.execPath,
        [
          resolve(
            "src/main/agent/providers/claude-subscription/fixtures/cli.mjs"
          ),
        ],
        { ...options, env: { ...options.env, NS_FIXTURE_MODE: state.mode } }
      )
    },
  }
})
vi.mock("../../env/host-cli-env", () => ({
  hostCliEnv: async () => ({ PATH: process.env.PATH }),
}))
vi.mock("./auth-policy", () => ({ verifyPersonalSubscription: vi.fn() }))
vi.mock("./windows-state", () => ({
  withWindowsProbeWorker: (_signal: AbortSignal, run: () => Promise<unknown>) =>
    run(),
  closeWindowsProbeWorker: async () => {},
  windowsPrivatePaths: vi.fn().mockResolvedValue(undefined),
  windowsPrivatePath: async (path: string, create: boolean) => {
    if (create)
      await (await import("fs/promises")).mkdir(path, { recursive: true })
  },
}))
vi.mock("./setup", async (original) => ({
  ...(await original<typeof import("./setup")>()),
  resolveExecutable: async () => process.execPath,
}))
vi.mock("./admission", async (original) => {
  const actual = await original<typeof import("./admission")>()
  return {
    ...actual,
    startAdmission: async (options: any) => {
      state.relay = await actual.startTestAdmission({
        ...options,
        upstream: state.origin,
      })
      return state.relay
    },
  }
})
import {
  buildClaudeSubscriptionClient,
  shutdownClaudeSubscription,
} from "./client"
import {
  loadClaudeSubscriptionCatalog,
  parseModelCatalog,
} from "./model-catalog"
import * as managedPolicy from "./managed-policy"
import { verifyPersonalSubscription } from "./auth-policy"
import { ClaudeSubscriptionError } from "./errors"

let root: string
let count = 0
let server: ReturnType<typeof createServer>
const body = {
  model: "claude-sonnet-4-6",
  max_tokens: 512,
  messages: [
    { role: "user", content: "past" },
    { role: "assistant", content: "past answer" },
    { role: "user", content: "now" },
  ],
  tools: [
    {
      type: "function",
      function: {
        name: "read_file",
        parameters: { type: "object", properties: {} },
      },
    },
  ],
}
beforeEach(async () => {
  vi.spyOn(managedPolicy, "guardManagedPolicy").mockResolvedValue()
  vi.mocked(verifyPersonalSubscription).mockReset().mockResolvedValue()
  state.mode = ""
  state.version = "2.1.286"
  state.spawns = 0
  count = 0
  root = await mkdtemp(join(tmpdir(), "ns-client-test-"))
  server = createServer((req, res) => {
    count++
    req.resume()
    const tool =
      state.mode === "tools" ||
      state.mode.startsWith("boundary-") ||
      state.mode.startsWith("recovery-")
    const events = [
      {
        type: "message_start",
        message: {
          id: "msg",
          role: "assistant",
          content: [],
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: tool
          ? {
              type: "tool_use",
              id: "call",
              name: "mcp__ns__read_file",
              input: {},
            }
          : { type: "text", text: "hello" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: tool ? "tool_use" : "end_turn" },
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" },
    ]
    if (state.mode === "boundary-split-text") {
      events[1].index = 1
      events[2].index = 1
      events.splice(
        1,
        0,
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "hello" },
        } as any,
        { type: "content_block_stop", index: 0 } as any
      )
    }
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.end(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  state.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(async () => {
  vi.restoreAllMocks()
  const closed = new Promise<void>((resolve) => server.close(() => resolve()))
  server.closeAllConnections()
  await closed
  await rm(root, { recursive: true, force: true })
})
const clean = async () =>
  expect(
    (await readdir(join(root, "claude-subscription-transport"))).sort()
  ).toEqual(["cwd"])

describe("split native assistant blocks", () => {
  it("retains text when a subsequent tool-only assistant event has no text", async () => {
    state.mode = "boundary-split-text"
    await expect(
      buildClaudeSubscriptionClient({ appData: root }).chat.completions.create(
        body
      )
    ).resolves.toMatchObject({
      choices: [
        {
          message: {
            content: "hello",
            tool_calls: [{ function: { name: "read_file" } }],
          },
        },
      ],
    })
    expect(count).toBe(1)
    await clean()
  })
})

describe("repeated replay initialization", () => {
  it("accepts matching isolation inventories across historical frames", async () => {
    state.mode = "repeated-init"
    await expect(
      buildClaudeSubscriptionClient({ appData: root }).chat.completions.create(
        body
      )
    ).resolves.toMatchObject({
      choices: [{ message: { content: "hello" } }],
    })
    expect(count).toBe(1)
    await clean()
  })
  it("rejects inventory drift even when both inventories are individually allowed", async () => {
    state.mode = "changed-init"
    await expect(
      buildClaudeSubscriptionClient({ appData: root }).chat.completions.create(
        body
      )
    ).rejects.toMatchObject({
      code: "claude_subscription_protocol",
    })
    expect(count).toBe(0)
    await clean()
  })
})

describe("context and auxiliary admission", () => {
  it.each([256, 700, 1024, 2048])(
    "keeps thinking configuration scoped to output cap %s",
    async (max_tokens) => {
      state.mode = "no-tools"
      await buildClaudeSubscriptionClient({
        appData: root,
      }).chat.completions.create({
        ...body,
        max_tokens,
        tools: [],
      })
      const settings = await state.settings
      expect(settings.env.MAX_THINKING_TOKENS).toBe(
        max_tokens < 1024 ? "0" : undefined
      )
      expect(JSON.parse(settings.env.CLAUDE_CODE_EXTRA_BODY).max_tokens).toBe(
        max_tokens
      )
      expect(count).toBe(1)
      await clean()
    }
  )
  it("rejects oversized canonical history before subprocess or upstream startup", () => {
    const client = buildClaudeSubscriptionClient({ appData: root })
    expect(() =>
      client.chat.completions.create({
        ...body,
        messages: [{ role: "user", content: "word ".repeat(160000) }],
      })
    ).toThrowError(
      expect.objectContaining({ code: "claude_subscription_context_overflow" })
    )
    expect(state.spawns).toBe(0)
    expect(count).toBe(0)
  })

  it("accepts default nonstream auxiliary shapes on conservative aliases", async () => {
    state.mode = "no-tools"
    const client = buildClaudeSubscriptionClient({ appData: root })
    await expect(
      client.chat.completions.create({
        model: "haiku",
        max_tokens: 256,
        messages: [
          { role: "system", content: "Generate a title or digest." },
          { role: "user", content: "canonical source" },
        ],
      })
    ).resolves.toMatchObject({ choices: [{ message: { content: "hello" } }] })
    expect(count).toBe(1)
    await clean()
  })

  it("cancels nonstream auxiliary work with its caller signal", async () => {
    state.mode = "stall"
    const controller = new AbortController()
    const client = buildClaudeSubscriptionClient({ appData: root })
    const pending = client.chat.completions.create(body, undefined, {
      signal: controller.signal,
    })
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    })
    await vi.waitFor(() => expect(count).toBe(1))
    controller.abort()
    await rejected
    await clean()
  })
})

describe("compatibility preflight", () => {
  it.each(["generation", "discovery"])(
    "rejects unqualified account before %s startup",
    async (operation) => {
      vi.mocked(verifyPersonalSubscription).mockRejectedValue(
        new ClaudeSubscriptionError(
          "claude_subscription_account_unqualified",
          "Account unqualified."
        )
      )
      const client = buildClaudeSubscriptionClient({ appData: root })
      await expect(
        operation === "generation"
          ? client.chat.completions.create(body)
          : client.models.list()
      ).rejects.toMatchObject({
        code: "claude_subscription_account_unqualified",
      })
      expect(state.spawns).toBe(0)
      expect(count).toBe(0)
      await clean()
    }
  )
  it.each(["generation", "discovery"])(
    "rejects local managed policy before %s protocol startup",
    async (operation) => {
      vi.spyOn(managedPolicy, "guardManagedPolicy").mockRejectedValue(
        new ClaudeSubscriptionError(
          "claude_subscription_managed_policy",
          "Managed policy present."
        )
      )
      const client = buildClaudeSubscriptionClient({ appData: root })
      await expect(
        operation === "generation"
          ? client.chat.completions.create(body)
          : client.models.list()
      ).rejects.toMatchObject({
        code: "claude_subscription_managed_policy",
        status: undefined,
      })
      expect(state.spawns).toBe(0)
      expect(count).toBe(0)
      await clean()
    }
  )
  it.each(["2.1.287", "2.2.0"])(
    "accepts newer CLI %s for generation and discovery and rechecks upgrades",
    async (version) => {
      const client = buildClaudeSubscriptionClient({ appData: root })
      await client.models.list()
      state.version = version
      await expect(client.chat.completions.create(body)).resolves.toMatchObject(
        {
          choices: [{ message: { content: "hello" } }],
        }
      )
      await expect(client.models.list()).resolves.toMatchObject({
        data: [{ id: "sonnet" }, { id: "claude-sonnet-4-6" }],
      })
      expect(state.spawns).toBe(3)
      expect(count).toBe(1)
      await clean()
    }
  )
  it.each(["generation", "discovery"])(
    "rejects an incompatible CLI before %s starts",
    async (operation) => {
      state.mode = "bad-version"
      const client = buildClaudeSubscriptionClient({ appData: root })
      const result =
        operation === "generation"
          ? client.chat.completions.create(body)
          : client.models.list()
      await expect(result).rejects.toMatchObject({
        code: "claude_subscription_cli_incompatible",
        status: undefined,
      })
      expect(state.spawns).toBe(0)
      expect(count).toBe(0)
      await clean()
    }
  )
})

describe("model discovery", () => {
  it("returns explicit fallback status without generation on an unsupported handshake", async () => {
    state.mode = "discovery-error"
    const catalog = await loadClaudeSubscriptionCatalog(root)
    expect(catalog.source).toBe("fallback")
    expect(catalog.models).toEqual([{ id: "claude-sonnet-4-6" }])
    expect(count).toBe(0)
    await clean()
  })
  it("retains previous and manual entries when discovery fails", async () => {
    state.mode = "discovery-wrong-id"
    const previous = [{ id: "claude-custom-route" }]
    expect(await loadClaudeSubscriptionCatalog(root, previous)).toMatchObject({
      source: "retained",
      models: previous,
    })
    expect(count).toBe(0)
    await clean()
  })
  it("excludes the logged-in Fable long-context catalog entry without enabling it", () => {
    expect(
      parseModelCatalog([
        { value: "default" },
        { value: "opus" },
        { value: "claude-fable-5-1[1m]" },
        { value: "sonnet" },
        { value: "haiku" },
      ])
    ).toEqual([{ id: "opus" }, { id: "sonnet" }, { id: "haiku" }])
  })
  it("excludes the unqualified fable alias without discarding supported routes", () => {
    expect(
      parseModelCatalog([
        { value: "default" },
        { value: "fable" },
        { value: "sonnet" },
      ])
    ).toEqual([{ id: "sonnet" }])
    expect(() => parseModelCatalog([{ value: "fable" }])).toThrow()
  })
  it("correlates initialization, excludes ambiguous default, and generates nothing", async () => {
    expect(
      await buildClaudeSubscriptionClient({ appData: root }).models.list()
    ).toEqual({ data: [{ id: "sonnet" }, { id: "claude-sonnet-4-6" }] })
    expect(count).toBe(0)
    await clean()
  })
  it.each([
    "discovery-wrong-id",
    "discovery-error",
    "discovery-empty",
    "discovery-prose",
    "discovery-bad-exit",
    "discovery-generate",
  ])("fails closed with cleanup on %s", async (mode) => {
    state.mode = mode
    await expect(
      buildClaudeSubscriptionClient({ appData: root }).models.list()
    ).rejects.toThrow()
    expect(count).toBe(0)
    await clean()
  })
  it("shutdown cancels a stalled discovery process", async () => {
    state.mode = "discovery-stall"
    const discovery = buildClaudeSubscriptionClient({
      appData: root,
    }).models.list()
    const checked = expect(discovery).rejects.toMatchObject({
      name: "AbortError",
    })
    await vi.waitFor(() => expect(state.spawns).toBe(1), { timeout: 20000 })
    shutdownClaudeSubscription()
    await checked
    await clean()
  })
  it.each(
    [
      [],
      [{ value: "default" }],
      [{ value: "sonnet" }, { value: "sonnet" }],
      [{ value: "--unsafe" }],
      [{ value: "https://example.com" }],
    ].map((catalog) => ({ catalog }))
  )("rejects unusable catalog %j", ({ catalog }) => {
    expect(() => parseModelCatalog(catalog)).toThrow()
  })
})

describe("final result and denied recovery", () => {
  it.each([false, true])(
    "preserves the complete first tool response after blocked recovery (stream %s)",
    async (stream) => {
      state.mode = "recovery-accepted"
      const result: any = await buildClaudeSubscriptionClient({
        appData: root,
      }).chat.completions.create({ ...body, stream })
      if (stream) {
        const chunks: any[] = []
        for await (const chunk of result) chunks.push(chunk)
        expect(chunks.at(-1).choices[0].delta.tool_calls[0].function.name).toBe(
          "read_file"
        )
      } else
        expect(result.choices[0].message.tool_calls[0].function.name).toBe(
          "read_file"
        )
      expect(count).toBe(1)
      expect(state.relay.diagnostics()).toMatchObject({
        admitted: 1,
        recoveryBlocked: 1,
      })
      await clean()
    }
  )
  it.each([
    "boundary-zero-turns",
    "boundary-one-turn",
    "boundary-extra-turns",
    "boundary-missing-turns",
    "boundary-late-assistant",
    "boundary-late-stream",
    "boundary-duplicate-result",
    "recovery-error",
    "recovery-bad-exit",
  ])("never publishes tools at invalid final boundary %s", async (mode) => {
    state.mode = mode
    const client = buildClaudeSubscriptionClient({ appData: root })
    await expect(client.chat.completions.create(body)).rejects.toMatchObject({
      code: "claude_subscription_protocol",
    })
    const stream: any = await client.chat.completions.create({
      ...body,
      stream: true,
    })
    const chunks: any[] = []
    await expect(
      (async () => {
        for await (const chunk of stream) chunks.push(chunk)
      })()
    ).rejects.toMatchObject({ code: "claude_subscription_protocol" })
    expect(chunks.some((chunk) => chunk.choices[0].delta.tool_calls)).toBe(
      false
    )
    expect(count).toBe(2)
    expect(state.relay.diagnostics().recoveryBlocked).toBe(
      mode.startsWith("recovery-") ? 1 : 0
    )
    await clean()
  })
})

describe("request-scoped subprocess lifecycle", () => {
  it("replays zero-turn acknowledgements and agrees in streaming/nonstream modes", async () => {
    const client = buildClaudeSubscriptionClient({ appData: root })
    const result: any = await client.chat.completions.create(body)
    expect(result.choices[0].message.content).toBe("hello")
    const stream: any = await client.chat.completions.create({
      ...body,
      stream: true,
    })
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    expect(
      chunks.map((chunk) => chunk.choices[0].delta.content ?? "").join("")
    ).toBe("hello")
    expect(chunks.at(-1).usage).toEqual(result.usage)
    expect(count).toBe(2)
    await clean()
  })
  it("publishes complete tools only at the accepted exit-1 max-turn boundary", async () => {
    state.mode = "tools"
    const result: any = await buildClaudeSubscriptionClient({
      appData: root,
    }).chat.completions.create(body)
    expect(result.choices[0].message.tool_calls).toEqual([
      {
        id: "call",
        type: "function",
        function: { name: "read_file", arguments: "{}" },
      },
    ])
    await clean()
  })
  it.each(["malformed", "bad-ack", "early-exit", "rewrite", "bad-exit"])(
    "fails closed and cleans up %s",
    async (mode) => {
      state.mode = mode
      await expect(
        buildClaudeSubscriptionClient({
          appData: root,
        }).chat.completions.create(body)
      ).rejects.toThrow()
      expect(count).toBe(["rewrite", "bad-exit"].includes(mode) ? 1 : 0)
      await clean()
    }
  )
  it.each([
    "native-tool",
    "native-skill",
    "native-plugin",
    "native-agent",
    "native-mcp",
  ])("rejects unexpected initialization %s before admission", async (mode) => {
    state.mode = mode
    await expect(
      buildClaudeSubscriptionClient({
        appData: root,
      }).chat.completions.create(body)
    ).rejects.toMatchObject({ code: "claude_subscription_isolation" })
    expect(count).toBe(0)
    await clean()
  })
  it("never admits a single-frame request without verified initialization", async () => {
    state.mode = "missing-init"
    await expect(
      buildClaudeSubscriptionClient({ appData: root }).chat.completions.create({
        ...body,
        messages: [{ role: "user", content: "now" }],
      })
    ).rejects.toThrow()
    expect(count).toBe(0)
    await clean()
  })
  it("early iterator return aborts while next is pending", async () => {
    state.mode = "stall"
    const stream: any = await buildClaudeSubscriptionClient({
      appData: root,
    }).chat.completions.create({ ...body, stream: true })
    await stream.next()
    const pending = stream.next()
    expect(await stream.return()).toMatchObject({ done: true })
    expect(await pending).toMatchObject({ done: true })
    await vi.waitFor(clean)
  })
  it("Stop cancels only its admitted stream on a shared client", async () => {
    state.mode = "stall"
    const client = buildClaudeSubscriptionClient({ appData: root })
    const controller = new AbortController()
    const first: any = await client.chat.completions.create(
      { ...body, stream: true },
      undefined,
      { signal: controller.signal }
    )
    const second: any = await client.chat.completions.create({
      ...body,
      stream: true,
    })
    await Promise.all([first.next(), second.next()])
    expect(count).toBe(2)
    const stopped = expect(first.next()).rejects.toMatchObject({
      name: "AbortError",
    })
    controller.abort()
    await stopped
    // The other stream is still live until its own owner ends it.
    const pending = second.next()
    expect(await second.return()).toMatchObject({ done: true })
    expect(await pending).toMatchObject({ done: true })
    await vi.waitFor(clean)
  })
  it("shutdown cancels all active generation owners and cleans their resources", async () => {
    state.mode = "stall"
    const streams: any[] = await Promise.all(
      [0, 1].map(() =>
        buildClaudeSubscriptionClient({
          appData: root,
        }).chat.completions.create({ ...body, stream: true })
      )
    )
    await Promise.all(streams.map((stream) => stream.next()))
    expect(count).toBe(2)
    const stopped = streams.map((stream) =>
      expect(stream.next()).rejects.toMatchObject({ name: "AbortError" })
    )
    shutdownClaudeSubscription()
    await Promise.all(stopped)
    await vi.waitFor(clean)
  })
  it("positional abort is independent across concurrent cached-client requests", async () => {
    const client = buildClaudeSubscriptionClient({ appData: root })
    const controller = new AbortController()
    const cancelled = client.chat.completions.create(body, undefined, {
      signal: controller.signal,
    }) as Promise<any>
    const checked = expect(cancelled).rejects.toMatchObject({
      name: "AbortError",
    })
    const healthy = client.chat.completions.create(body) as Promise<any>
    controller.abort()
    await checked
    expect((await healthy).choices[0].message.content).toBe("hello")
    await clean()
  })
})
