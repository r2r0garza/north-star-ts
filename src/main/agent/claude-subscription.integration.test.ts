import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import Database from "better-sqlite3"
import { createServer } from "http"
import type { AddressInfo } from "net"
import {
  mkdtemp,
  mkdir,
  readdir,
  rm,
  writeFile,
  readFile,
  access,
} from "fs/promises"
import { tmpdir } from "os"
import { join, resolve } from "path"
import { runMigrations } from "../db/migrations"
import { sqliteLoadsForTests } from "../test/sqlite"

const fixture = vi.hoisted(() => ({
  root: "",
  home: "",
  origin: "",
  relays: [] as any[],
  models: [] as string[],
}))
let db: Database.Database
vi.mock("../db/connection", () => ({ getDb: () => db }))
vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => (name === "home" ? fixture.home : fixture.root),
    getAppPath: () => process.cwd(),
  },
}))
vi.mock("./memory/service", () => ({ recordMemoryTurn: vi.fn(async () => {}) }))
vi.mock("../settings/secrets", () => ({
  getApiKey: () => {
    throw new Error("subscription must not read API secrets")
  },
  setApiKey: vi.fn(),
}))
vi.mock("./env/host-cli-env", () => ({
  hostCliEnv: async () => ({
    PATH: process.env.PATH,
    HOME: fixture.home,
    USERPROFILE: fixture.home,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    APPDATA: join(fixture.home, "AppData", "Roaming"),
    LOCALAPPDATA: join(fixture.home, "AppData", "Local"),
  }),
}))
vi.mock("./providers/claude-subscription/auth-policy", () => ({
  verifyPersonalSubscription: vi.fn(),
}))
vi.mock("./providers/claude-subscription/setup", async (original) => {
  const actual =
    await original<typeof import("./providers/claude-subscription/setup")>()
  return {
    ...actual,
    guardEnvironment: (env: NodeJS.ProcessEnv) => ({
      ...actual.guardEnvironment(env),
      ANTHROPIC_API_KEY: "synthetic-not-a-real-key",
      CLAUDE_CONFIG_DIR: join(fixture.home, ".claude"),
    }),
  }
})
vi.mock("./providers/claude-subscription/admission", async (original) => {
  const actual =
    await original<typeof import("./providers/claude-subscription/admission")>()
  return {
    ...actual,
    startAdmission: async (options: any) => {
      const relay = await actual.startTestAdmission({
        ...options,
        upstream: fixture.origin,
      })
      fixture.relays.push(relay)
      return relay
    },
  }
})
vi.mock("child_process", async (original) => {
  const actual = await original<typeof import("child_process")>()
  return {
    ...actual,
    spawn: (executable: string, args: string[], options: any) => {
      if (args.includes("--model"))
        fixture.models.push(args[args.indexOf("--model") + 1])
      if (
        process.env.NS_QUALIFY_HOST_LOOP_INSTALLED !== "1" &&
        /[\\/]claude(?:\.exe)?$/.test(executable)
      )
        return actual.spawn(
          process.execPath,
          [
            resolve(
              "src/main/agent/providers/claude-subscription/fixtures/host-loop.mjs"
            ),
            ...args,
          ],
          options
        )
      return actual.spawn(executable, args, options)
    },
  }
})

import { runAgentLoop, resolveApproval } from "."
import { invalidate } from "./providers"
import { createAccount } from "../db/repositories/provider-accounts"
import { addModel } from "../db/repositories/models"
import {
  createConversation,
  updateConversation,
} from "../db/repositories/conversations"
import { appendMessage, listMessages } from "../db/repositories/messages"
import { upsertConversationSummary } from "../db/repositories/conversation-summaries"
import { listToolCallLifecycle } from "../db/repositories/tool-call-lifecycle"
import { getBudget } from "../db/repositories/model-request-retry-budgets"
import { generateTitle } from "./title"
import { parseAgent } from "./agents/loader"
import { SummaryService } from "../summaries/service"
import { routeCandidates } from "../tasks/process/router"
import { createTask } from "../db/repositories/tasks"
import { getConversationSummary } from "../db/repositories/conversation-summaries"
import {
  _resetCacheForTests,
  setLlm,
  setTitleGeneration,
  setMemory,
} from "../settings/service"
import type { TaskRunner } from "../tasks/runner"
import { dataDirName } from "../config/system-name"

const sqliteLoads = sqliteLoadsForTests()
let server: ReturnType<typeof createServer>
let workspace: string
let captured: any[]
let responses: Array<{
  tool?: string
  args?: Record<string, unknown>
  text?: string
}>
let selection: { accountId: string; modelId: string }
let stall = false

beforeEach(async () => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
  _resetCacheForTests()
  invalidate()
  fixture.root = await mkdtemp(join(tmpdir(), "ns-host-subscription-"))
  fixture.home = join(fixture.root, "home")
  workspace = join(fixture.root, "workspace")
  await mkdir(fixture.home)
  await mkdir(workspace)
  // Synthetic mode still exercises normal executable discovery without requiring
  // an installed CLI. The spawn substitution uses this inert executable marker.
  if (process.env.NS_QUALIFY_HOST_LOOP_INSTALLED !== "1") {
    const bin = join(fixture.root, "bin")
    await mkdir(bin)
    await writeFile(
      join(bin, process.platform === "win32" ? "claude.exe" : "claude"),
      "",
      { mode: 0o700 }
    )
    vi.stubEnv(
      "PATH",
      `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`
    )
  }
  fixture.relays = []
  fixture.models = []
  captured = []
  responses = []
  stall = false
  const account = createAccount({
    provider: "claude_subscription",
    displayName: "synthetic subscription",
  })
  addModel({ accountId: account.id, modelId: "claude-sonnet-4-6" })
  selection = { accountId: account.id, modelId: "claude-sonnet-4-6" }
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    captured.push(JSON.parse(Buffer.concat(chunks).toString()))
    const response = responses.shift()
    if (!response) {
      res.writeHead(500).end()
      return
    }
    const tool = response.tool
    const events = [
      {
        type: "message_start",
        message: {
          id: `msg_${captured.length}`,
          type: "message",
          role: "assistant",
          model: selection.modelId,
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
              id: `call_${captured.length}`,
              name: `mcp__ns__${tool}`,
              input: {},
            }
          : { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: tool
          ? {
              type: "input_json_delta",
              partial_json: JSON.stringify(response.args ?? {}),
            }
          : { type: "text_delta", text: response.text ?? "Complete." },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: {
          stop_reason: tool ? "tool_use" : "end_turn",
          stop_sequence: null,
        },
        usage: { output_tokens: 2 },
      },
      { type: "message_stop" },
    ]
    res.writeHead(200, { "content-type": "text/event-stream" })
    if (stall) {
      res.write(
        events
          .slice(0, 3)
          .map(
            (event) =>
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
          )
          .join("")
      )
      return
    }
    res.end(
      events
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
        )
        .join("")
    )
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  fixture.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(async () => {
  if (!sqliteLoads) return
  for (const relay of fixture.relays) await relay.close()
  await new Promise<void>((done) => {
    server.close(() => done())
    server.closeAllConnections()
  })
  db.close()
  vi.unstubAllEnvs()
  await rm(fixture.root, { recursive: true, force: true })
})

async function clean() {
  expect(responses).toHaveLength(0)
  expect(fixture.relays).toHaveLength(captured.length)
  for (const relay of fixture.relays)
    expect(relay.diagnostics().admitted).toBe(1)
  expect(
    await readdir(join(fixture.root, "claude-subscription-transport"))
  ).toEqual(["cwd"])
}

// The same host/DB tests run with either a synthetic subprocess (default) or the
// installed official CLI (opt-in), always with disposable auth and loopback only.
describe.skipIf(!sqliteLoads)(
  "subscription host-owned loop qualification",
  () => {
    it("extracts memory through its selected alias and stages the returned fact", async () => {
      const memory =
        await vi.importActual<typeof import("./memory/service")>(
          "./memory/service"
        )
      addModel({ accountId: selection.accountId, modelId: "haiku" })
      setLlm({
        activeAccountId: selection.accountId,
        activeModelId: selection.modelId,
      })
      setMemory({
        enabled: true,
        accountId: selection.accountId,
        modelId: "haiku",
      })
      responses.push({
        text: JSON.stringify({
          candidates: [
            {
              id: "c1",
              text: "The release checklist lives in docs/release.md.",
              category: "knowledge",
              kind: "declarative",
              sourceIds: ["user:0"],
            },
          ],
        }),
      })
      await memory.recordMemoryTurn({
        conversationId: "memory-qualification",
        userText: "The release checklist lives in docs/release.md.",
        assistantText: "Noted.",
        workspaceDir: workspace,
      })
      expect(captured).toHaveLength(1)
      expect(captured[0].tools ?? []).toEqual([])
      expect(fixture.models).toEqual(["haiku"])
      expect(
        await readFile(
          join(
            workspace,
            dataDirName(),
            "skills",
            "memory-recent",
            "staging.md"
          ),
          "utf8"
        )
      ).toContain("The release checklist lives in docs/release.md.")
      await clean()
    }, 60000)

    it("generates a title on its independent alias selection without effort or tool probes", async () => {
      addModel({ accountId: selection.accountId, modelId: "haiku" })
      setLlm({
        activeAccountId: selection.accountId,
        activeModelId: selection.modelId,
      })
      setTitleGeneration({ accountId: selection.accountId, modelId: "haiku" })
      responses.push({ text: "TITLE: Independent Title Route" })
      expect(
        await generateTitle("Check the selected title generation route")
      ).toBe("Independent Title Route")
      expect(captured).toHaveLength(1)
      expect(fixture.models).toEqual(["haiku"])
      expect(captured[0].max_tokens).toBe(256)
      expect(captured[0].output_config?.effort).toBeUndefined()
      expect(captured[0].tools ?? []).toEqual([])
      await clean()
    }, 60000)

    it("uses the selected subscription adapter for process/seat classification", async () => {
      responses.push({ text: "reviewer" })
      expect(
        await routeCandidates({
          candidates: [
            { name: "builder", description: "implements" },
            { name: "reviewer", description: "reviews" },
          ],
          taskPrompt: "Review the changes",
          selection,
          signal: new AbortController().signal,
        })
      ).toBe("reviewer")
      expect(captured).toHaveLength(1)
      expect(captured[0].max_tokens).toBe(64)
      expect(captured[0].tools ?? []).toEqual([])
      await clean()
    }, 60000)

    it("generates a host summary through the adapter and continues from its persisted boundary", async () => {
      const conversation = createConversation({
        mode: "interactive",
        ...selection,
      })
      appendMessage({
        conversationId: conversation.id,
        role: "user",
        content: "original source to fold",
      })
      const last = appendMessage({
        conversationId: conversation.id,
        role: "assistant",
        content: "original answer to fold",
      })
      const task = createTask({
        conversationId: conversation.id,
        input: { kind: "summarize", conversationId: conversation.id },
      })
      responses.push({ text: "Host-generated durable digest." })
      const summary = new SummaryService({} as TaskRunner)
      const outcome = await summary.execute({
        task,
        signal: new AbortController().signal,
        emit: () => {},
        workspace: undefined,
      })
      expect(outcome).not.toHaveProperty("error")
      expect(getConversationSummary(conversation.id)).toMatchObject({
        coversThrough: last.seq,
        summary: "Host-generated durable digest.",
      })
      expect(captured[0].tools ?? []).toEqual([])
      responses.push({ text: "Continued after summary." })
      expect(
        await runAgentLoop({
          conversationId: conversation.id,
          workspace,
          userMessage: "Continue from the digest",
          abort: new AbortController(),
          allowedToolNames: new Set(["read_file_tool"]),
        })
      ).toMatchObject({ content: "Continued after summary." })
      const payload = JSON.stringify(captured[1])
      expect(payload).toContain("Host-generated durable digest.")
      expect(payload).toContain("Continue from the digest")
      expect(payload).not.toContain("original source to fold")
      await clean()
    }, 60000)

    it("narrows native inventory for a read-only custom agent and refuses a fabricated write", async () => {
      const agent = parseAgent(
        "---\nname: reader\ndescription: Read-only qualification agent\ntools: [read]\nskills: []\nmcpServers: []\n---\nOnly inspect files.",
        join(workspace, "reader.agent.md"),
        "reader",
        workspace
      )
      expect(agent).not.toBeNull()
      const conversation = createConversation({
        mode: "interactive",
        ...selection,
      })
      responses.push({
        tool: "write_file_tool",
        args: { path: "forbidden.txt", content: "must not appear" },
      })
      const events: any[] = []
      const result = await runAgentLoop({
        conversationId: conversation.id,
        workspace,
        userMessage: "Inspect without writes",
        agentOverride: agent,
        abort: new AbortController(),
        onEvent: (event) => events.push(event),
      })
      expect(result).toHaveProperty("error")
      const names = captured[0].tools.map((tool: any) => tool.name)
      expect(names).toContain("mcp__ns__read_file_tool")
      expect(names).not.toContain("mcp__ns__write_file_tool")
      expect(names).not.toContain("mcp__ns__exec_command")
      expect(
        events.some(
          (event) => event.type === "approval" || event.type === "tool_start"
        )
      ).toBe(false)
      expect(listToolCallLifecycle(conversation.id)).toEqual([])
      await expect(access(join(workspace, "forbidden.txt"))).rejects.toThrow()
      await clean()
    }, 60000)

    it("runs workspace-free Chat through ordinary subscription routing", async () => {
      const conversation = createConversation({ mode: "chat", ...selection })
      responses.push({ text: "Chat reply." })
      expect(
        await runAgentLoop({
          conversationId: conversation.id,
          userMessage: "Hello from Chat",
          provideBrowser: () => ({ state: () => ({}) }) as any,
          abort: new AbortController(),
        })
      ).toMatchObject({ content: "Chat reply." })
      expect(listMessages(conversation.id).map((row) => row.role)).toEqual([
        "user",
        "assistant",
      ])
      expect(JSON.stringify(captured[0].messages)).toContain("Hello from Chat")
      await clean()
    }, 60000)

    it("delivers a host screenshot only within its turn and replays its durable text without pixels", async () => {
      const jpeg = Buffer.from(
        "/9j/4AAQSkZJRgABAQAASABIAAD/4QBARXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAAqACAAQAAAABAAAAAaADAAQAAAABAAAAAQAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/+IB2ElDQ19QUk9GSUxFAAEBAAAByAAAAAAEMAAAbW50clJHQiBYWVogB+AAAQABAAAAAAAAYWNzcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPbWAAEAAAAA0y0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJZGVzYwAAAPAAAAAkclhZWgAAARQAAAAUZ1hZWgAAASgAAAAUYlhZWgAAATwAAAAUd3RwdAAAAVAAAAAUclRSQwAAAWQAAAAoZ1RSQwAAAWQAAAAoYlRSQwAAAWQAAAAoY3BydAAAAYwAAAA8bWx1YwAAAAAAAAABAAAADGVuVVMAAAAIAAAAHABzAFIARwBCWFlaIAAAAAAAAG+iAAA49QAAA5BYWVogAAAAAAAAYpkAALeFAAAY2lhZWiAAAAAAAAAkoAAAD4QAALbPWFlaIAAAAAAAAPbWAAEAAAAA0y1wYXJhAAAAAAAEAAAAAmZmAADypwAADVkAABPQAAAKWwAAAAAAAAAAbWx1YwAAAAAAAAABAAAADGVuVVMAAAAgAAAAHABHAG8AbwBnAGwAZQAgAEkAbgBjAC4AIAAyADAAMQA2/8AAEQgAAQABAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A/cSiiiuw5z//2Q==",
        "base64"
      )
      const screenshot = vi.fn(async () => ({ jpeg, width: 32, height: 24 }))
      const conversation = createConversation({ mode: "chat", ...selection })
      responses.push(
        { tool: "browser_screenshot" },
        { text: "Inspected the screenshot." }
      )
      expect(
        await runAgentLoop({
          conversationId: conversation.id,
          userMessage: "Inspect the current page",
          provideBrowser: () => ({ screenshot, state: () => ({}) }) as any,
          allowedToolNames: new Set(["browser_screenshot"]),
          abort: new AbortController(),
        })
      ).toMatchObject({ content: "Inspected the screenshot." })
      expect(screenshot).toHaveBeenCalledOnce()
      const images = (request: any) =>
        request.messages.flatMap((message: any) =>
          Array.isArray(message.content)
            ? message.content.filter((part: any) => part.type === "image")
            : []
        )
      expect(images(captured[0])).toEqual([])
      expect(images(captured[1])).toEqual([
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/jpeg",
            data: jpeg.toString("base64"),
          },
        },
      ])
      const rows = listMessages(conversation.id)
      expect(rows.map((row) => row.role)).toEqual([
        "user",
        "assistant",
        "tool",
        "assistant",
      ])
      expect(rows.find((row) => row.role === "tool")?.content).toContain(
        "Screenshot captured (32×24)"
      )
      expect(JSON.stringify(rows)).not.toContain(jpeg.toString("base64"))
      responses.push({ text: "Only the capture record remains." })
      expect(
        await runAgentLoop({
          conversationId: conversation.id,
          userMessage: "Continue without taking another screenshot",
          allowedToolNames: new Set(["read_file_tool"]),
          abort: new AbortController(),
        })
      ).toMatchObject({ content: "Only the capture record remains." })
      expect(images(captured[2])).toEqual([])
      expect(JSON.stringify(captured[2].messages)).toContain(
        "Screenshot captured (32×24)"
      )
      expect(screenshot).toHaveBeenCalledOnce()
      await clean()
    }, 60000)

    it("reads standalone image attachments as metadata without silently enabling vision", async () => {
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=",
        "base64"
      )
      const attachment = join(fixture.root, "attached-image.png")
      await writeFile(attachment, png)
      const conversation = createConversation({ mode: "chat", ...selection })
      responses.push(
        { tool: "read_document", args: { path: "attached-image.png" } },
        { text: "The attachment contains image metadata only." }
      )
      expect(
        await runAgentLoop({
          conversationId: conversation.id,
          attachments: [attachment],
          userMessage: "Read the attached image",
          allowedToolNames: new Set(["read_document"]),
          abort: new AbortController(),
        })
      ).toMatchObject({
        content: "The attachment contains image metadata only.",
      })
      const result = listMessages(conversation.id).find(
        (row) => row.role === "tool"
      )
      expect(result?.content).toContain('"width": 1')
      expect(result?.content).toContain('"height": 1')
      expect(result?.content).toContain(
        "Image OCR and vision analysis are not part"
      )
      for (const request of captured) {
        expect(JSON.stringify(request.messages)).not.toContain(
          png.toString("base64")
        )
        expect(
          request.messages.flatMap((message: any) =>
            Array.isArray(message.content)
              ? message.content.filter((part: any) => part.type === "image")
              : []
          )
        ).toEqual([])
      }
      await clean()
    }, 60000)

    it("reads a Chat attachment through host tools and reconstructs its durable result", async () => {
      const attachment = join(fixture.root, "attached-note.txt")
      await writeFile(attachment, "Attachment-only qualification marker.")
      const conversation = createConversation({ mode: "chat", ...selection })
      responses.push(
        { tool: "read_file_tool", args: { path: "attached-note.txt" } },
        { text: "Read the attached note." }
      )
      expect(
        await runAgentLoop({
          conversationId: conversation.id,
          attachments: [attachment],
          userMessage: "Read my attached note",
          allowedToolNames: new Set(["read_file_tool"]),
          abort: new AbortController(),
        })
      ).toMatchObject({ content: "Read the attached note." })
      expect(JSON.stringify(captured[1].messages)).toContain(
        "Attachment-only qualification marker."
      )
      expect(listMessages(conversation.id).map((row) => row.role)).toEqual([
        "user",
        "assistant",
        "tool",
        "assistant",
      ])
      responses.push({ text: "I remember the attached note." })
      expect(
        await runAgentLoop({
          conversationId: conversation.id,
          userMessage: "Recall the note without rereading it",
          allowedToolNames: new Set(["read_file_tool"]),
          abort: new AbortController(),
        })
      ).toMatchObject({ content: "I remember the attached note." })
      expect(JSON.stringify(captured[2].messages)).toContain(
        "Attachment-only qualification marker."
      )
      expect(captured).toHaveLength(3)
      await clean()
    }, 60000)

    it("Stop cancels an admitted host request without tools or an extra generation", async () => {
      const conversation = createConversation({
        mode: "interactive",
        ...selection,
      })
      const abort = new AbortController()
      stall = true
      responses.push({ text: "partial" })
      const pending = runAgentLoop({
        conversationId: conversation.id,
        workspace,
        userMessage: "Start bounded work",
        abort,
        allowedToolNames: new Set(["read_file_tool"]),
      })
      await vi.waitFor(() => expect(captured).toHaveLength(1))
      abort.abort()
      const result = await pending
      expect(result).not.toHaveProperty("error")
      expect(
        listMessages(conversation.id).some((row) => row.role === "tool")
      ).toBe(false)
      expect(listToolCallLifecycle(conversation.id)).toEqual([])
      await clean()
    }, 60000)

    it("executes a host read and replays durable tool rows on a resumed background turn", async () => {
      await writeFile(join(workspace, "source.txt"), "host-owned evidence")
      const conversation = createConversation({
        mode: "interactive",
        ...selection,
      })
      responses.push(
        { tool: "read_file_tool", args: { path: "source.txt" } },
        { text: "Read complete." }
      )
      const result = await runAgentLoop({
        conversationId: conversation.id,
        workspace,
        userMessage: "Read source.txt",
        abort: new AbortController(),
        allowedToolNames: new Set(["read_file_tool"]),
      })
      expect(result).toMatchObject({ content: "Read complete." })
      expect(JSON.stringify(captured[1].messages)).toContain(
        "host-owned evidence"
      )
      const history = listMessages(conversation.id)
      expect(history.map((row) => row.role)).toEqual([
        "user",
        "assistant",
        "tool",
        "assistant",
      ])
      expect(history[1].toolCalls?.[0].name).toBe("read_file_tool")
      expect(history[2].toolCallId).toBe(history[1].toolCalls?.[0].id)
      expect(listToolCallLifecycle(conversation.id)).toHaveLength(1)
      expect(getBudget(conversation.id, "after-seq:1")?.status).toBe(
        "completed"
      )
      appendMessage({
        conversationId: conversation.id,
        role: "user",
        content: "Continue from durable history",
      })
      responses.push({ text: "Background continuation." })
      expect(
        await runAgentLoop({
          conversationId: conversation.id,
          workspace,
          abort: new AbortController(),
          allowedToolNames: new Set(["read_file_tool"]),
        })
      ).toMatchObject({ content: "Background continuation." })
      expect(JSON.stringify(captured[2].messages)).toContain(
        "host-owned evidence"
      )
      await clean()
    }, 60000)

    it("keeps host approval denial authoritative and persists its tool feedback", async () => {
      const conversation = createConversation({
        mode: "interactive",
        ...selection,
      })
      responses.push(
        {
          tool: "write_file_tool",
          args: { path: "denied.txt", content: "must not appear" },
        },
        { text: "Denied by host." }
      )
      let approvals = 0
      const result = await runAgentLoop({
        conversationId: conversation.id,
        workspace,
        userMessage: "Create denied.txt",
        abort: new AbortController(),
        allowedToolNames: new Set(["write_file_tool"]),
        onEvent: (event) => {
          if (event.type === "approval") {
            approvals++
            queueMicrotask(() => resolveApproval(event.requestId, "denied"))
          }
        },
      })
      expect(result).toMatchObject({ content: "Denied by host." })
      expect(approvals).toBe(1)
      await expect(access(join(workspace, "denied.txt"))).rejects.toThrow()
      expect(
        listMessages(conversation.id).find((row) => row.role === "tool")
          ?.content
      ).toContain("ERROR[denied]")
      expect(JSON.stringify(captured[1].messages)).toContain("ERROR[denied]")
      await clean()
    }, 60000)

    it("reconstructs edited/deleted and provider-switched history with atomic host summary coverage", async () => {
      const priorAccount = createAccount({
        provider: "claude_code",
        displayName: "prior native account",
      })
      const conversation = createConversation({
        mode: "interactive",
        accountId: priorAccount.id,
        modelId: "sonnet",
      })
      const old = appendMessage({
        conversationId: conversation.id,
        role: "user",
        content: "old secret turn to summarize",
      })
      appendMessage({
        conversationId: conversation.id,
        role: "assistant",
        content: "old answer",
      })
      const edited = appendMessage({
        conversationId: conversation.id,
        role: "user",
        content: "stale edit",
      })
      const removed = appendMessage({
        conversationId: conversation.id,
        role: "assistant",
        content: "deleted answer",
      })
      db.prepare("UPDATE messages SET content = ? WHERE id = ?").run(
        "current edited tail",
        edited.id
      )
      db.prepare("DELETE FROM messages WHERE id = ?").run(removed.id)
      upsertConversationSummary({
        conversationId: conversation.id,
        summary: "host summary covers old turns",
        coversThrough: old.seq + 1,
        messageCount: 2,
        tokenEstimate: 10,
      })
      updateConversation(conversation.id, selection)
      responses.push({ text: "Canonical continuation." })
      expect(
        await runAgentLoop({
          conversationId: conversation.id,
          workspace,
          userMessage: "Continue after switch",
          abort: new AbortController(),
          allowedToolNames: new Set(["read_file_tool"]),
        })
      ).toMatchObject({ content: "Canonical continuation." })
      const payload = JSON.stringify(captured[0])
      expect(payload).toContain("host summary covers old turns")
      expect(payload).toContain("current edited tail")
      expect(payload).not.toContain("stale edit")
      expect(payload).not.toContain("deleted answer")
      expect(payload).not.toContain("old secret turn")
      await clean()
    }, 60000)
  }
)
