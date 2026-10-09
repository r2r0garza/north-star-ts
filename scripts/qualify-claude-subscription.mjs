import { spawn } from "node:child_process"
import { isolationFixture } from "./claude-subscription-isolation-fixture.mjs"
import { createServer } from "node:http"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import assert from "node:assert/strict"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"

const toolMode = process.argv.includes("--tool-response")
const isolationControl = process.argv.includes("--isolation-control")
const manifest = [
  {
    name: "probe",
    description: "Synthetic inert probe",
    inputSchema: { type: "object", properties: {} },
  },
]
let listed = 0
let calls = 0
let unrelatedInventoryRequests = 0
const inventory = createServer(async (req, res) => {
  if (req.url !== "/mcp") {
    unrelatedInventoryRequests++
    res.writeHead(404).end()
    return
  }
  const mcp = new Server(
    { name: "north_star", version: "1.0.0" },
    { capabilities: { tools: {} } }
  )
  mcp.setRequestHandler(ListToolsRequestSchema, async () => {
    listed++
    return { tools: manifest }
  })
  mcp.setRequestHandler(CallToolRequestSchema, async () => {
    calls++
    return {
      isError: true,
      content: [{ type: "text", text: "Inert inventory" }],
    }
  })
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  try {
    await mcp.connect(transport)
    await transport.handleRequest(req, res)
  } finally {
    await mcp.close()
    await transport.close()
  }
})
await new Promise((resolve) => inventory.listen(0, "127.0.0.1", resolve))

// Synthetic credentials and loopback responses only; never contacts a model service.
const root = await mkdtemp(join(tmpdir(), "ns-claude-qualification-"))
const isolation =
  process.argv.includes("--isolation") || isolationControl
    ? await isolationFixture(
        root,
        `http://127.0.0.1:${inventory.address().port}`
      )
    : undefined
const cwd = isolation?.cwd ?? join(root, "cwd")
await mkdir(cwd, { recursive: true })
let requests = 0
let nativeBody
const server = createServer(async (req, res) => {
  if (!req.url?.startsWith("/v1/messages")) {
    res.writeHead(404).end()
    return
  }
  requests++
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  nativeBody = JSON.parse(Buffer.concat(chunks).toString())
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_synthetic",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "synthetic response" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 2 },
    },
    { type: "message_stop" },
  ]
  if (toolMode) {
    events[1].content_block = {
      type: "tool_use",
      id: "tool_synthetic",
      name: "mcp__north_star__probe",
      input: {},
    }
    events[2].delta = { type: "input_json_delta", partial_json: "{}" }
    events[4].delta.stop_reason = "tool_use"
  }
  res.writeHead(200, { "content-type": "text/event-stream" })
  res.end(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
      )
      .join("")
  )
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
let child
try {
  const system = join(root, "system.txt")
  const settings = join(root, "settings.json")
  const mcp = join(root, "mcp.json")
  await writeFile(system, "Synthetic qualification system.", { mode: 0o600 })
  await writeFile(
    settings,
    JSON.stringify({
      disableAllHooks: !isolationControl,
      enabledPlugins: {
        "cc-plugin-agents-md@builtin": false,
        "cc-plugin-plugin-authoring@builtin": false,
      },
      env: {
        CLAUDE_CODE_EXTRA_BODY: JSON.stringify({
          max_tokens: 512,
          tools: manifest.map((tool) => ({
            name: "mcp__north_star__" + tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
          })),
        }),
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: "512",
      },
    }),
    { mode: 0o600 }
  )
  await writeFile(
    mcp,
    JSON.stringify({
      mcpServers: {
        north_star: {
          type: "http",
          url: `http://127.0.0.1:${inventory.address().port}/mcp`,
        },
      },
    }),
    { mode: 0o600 }
  )
  const env = { ...process.env }
  for (const key of Object.keys(env))
    if (
      /^(?:ANTHROPIC_|CLAUDE_CODE_|https?_proxy|all_proxy|NODE_OPTIONS)/i.test(
        key
      )
    )
      delete env[key]
  Object.assign(env, {
    ANTHROPIC_API_KEY: "synthetic-not-a-real-key",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_AUTO_COMPACT: "1",
    ENABLE_TOOL_SEARCH: "false",
    CLAUDE_CODE_MAX_RETRIES: "0",
  })
  const fixtureHome = isolation?.home ?? join(root, "home")
  await mkdir(fixtureHome, { recursive: true })
  env.HOME = fixtureHome
  env.USERPROFILE = fixtureHome
  env.APPDATA = join(fixtureHome, "AppData", "Roaming")
  env.LOCALAPPDATA = join(fixtureHome, "AppData", "Local")
  env.CLAUDE_CONFIG_DIR = isolation?.config ?? join(fixtureHome, ".claude")
  child = spawn(
    "claude",
    [
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--tools",
      "",
      "--model",
      "claude-sonnet-4-6",
      "--system-prompt-file",
      system,
      "--settings",
      settings,
      "--setting-sources",
      isolationControl ? "user,project,local" : "",
      "--strict-mcp-config",
      "--mcp-config",
      mcp,
      ...(process.argv.includes("--safe-mode") ? ["--safe-mode"] : []),
      "--disable-slash-commands",
      "--max-turns",
      "1",
      "--permission-mode",
      "dontAsk",
      "--no-session-persistence",
    ],
    {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    }
  )
  let output = ""
  let acked = false
  let final
  let initialization
  let callbackError
  let stderrBytes = 0
  const timer = setTimeout(() => child.kill("SIGKILL"), 30000)
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length
  })
  child.stdout.on("data", (chunk) => {
    output += chunk.toString()
    while (output.includes("\n")) {
      const index = output.indexOf("\n")
      const line = output.slice(0, index)
      output = output.slice(index + 1)
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (event.type === "system" && event.subtype === "init")
        initialization = event
      if (event.type === "result" && !acked) {
        if (
          !initialization ||
          requests !== 0 ||
          event.num_turns !== 0 ||
          event.is_error !== false
        ) {
          callbackError = new Error(
            "Historical replay acknowledgement failed qualification"
          )
          child.kill("SIGKILL")
          return
        }
        acked = true
        child.stdin.write(
          JSON.stringify({
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "historical answer" }],
            },
          }) + "\n"
        )
        child.stdin.end(
          JSON.stringify({
            type: "user",
            message: {
              role: "user",
              content: [{ type: "text", text: "final synthetic query" }],
            },
          }) + "\n"
        )
      } else if (event.type === "result") final = event
    }
  })
  child.stdin.write(
    JSON.stringify({
      type: "user",
      shouldQuery: false,
      message: {
        role: "user",
        content: [{ type: "text", text: "historical synthetic query" }],
      },
    }) + "\n"
  )
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("close", resolve)
  })
  clearTimeout(timer)
  const isolationResult = isolation
    ? await isolation.result(nativeBody)
    : undefined
  console.log(
    JSON.stringify({
      isolation: isolationResult,
      unrelatedInventoryRequests,
      platform: process.platform,
      toolMode,
      exitCode: code,
      replayAcknowledged: acked,
      requests,
      finalSubtype: final?.subtype,
      stderrBytes,
      listed,
      calls,
      capMatches: nativeBody?.max_tokens === 512,
      toolsMatch: nativeBody?.tools?.[0]?.name === "mcp__north_star__probe",
    })
  )
  if (callbackError) throw callbackError
  assert.equal(code, toolMode ? 1 : 0)
  assert.equal(acked, true)
  assert.equal(requests, 1)
  if (toolMode) assert.equal(final?.subtype, "error_max_turns")
  else assert.equal(final?.result, "synthetic response")
  assert.equal(nativeBody.max_tokens, 512)
  assert.equal(nativeBody.tools[0].name, "mcp__north_star__probe")
  assert.ok(listed > 0)
  assert.equal(calls, 0)
  assert.equal(unrelatedInventoryRequests, 0)
  if (isolationResult) {
    assert.ok(initialization, "Missing native initialization inventory")
    if (!isolationControl) {
      assert.deepEqual(initialization.skills ?? [], [])
      assert.deepEqual(initialization.plugins ?? [], [])
      assert.ok(Array.isArray(initialization.mcp_servers))
      assert.ok(
        initialization.mcp_servers.every(
          (server) =>
            server.name === "north_star" && server.status === "connected"
        )
      )
      assert.ok(
        !(initialization.agents ?? []).includes("fixture-agent"),
        "Project agent loaded"
      )
      assert.ok(
        (initialization.tools ?? []).every(
          (name) => name === "mcp__north_star__probe"
        ),
        "Unexpected native tools"
      )
    }
    assert.equal(isolationResult.hookRan, isolationControl)
    if (!isolationControl) assert.equal(isolationResult.markerLeaked, false)
  }
} finally {
  if (child?.pid) {
    try {
      process.kill(
        process.platform === "win32" ? child.pid : -child.pid,
        "SIGKILL"
      )
    } catch {}
  }
  await new Promise((resolve) => {
    server.close(resolve)
    server.closeAllConnections()
  })
  await new Promise((resolve) => {
    inventory.close(resolve)
    inventory.closeAllConnections()
  })
  await rm(root, { recursive: true, force: true })
}
