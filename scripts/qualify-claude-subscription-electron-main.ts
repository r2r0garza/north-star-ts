import { app } from "electron"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, readdir, writeFile, access, realpath } from "node:fs/promises"
import { join } from "node:path"
import {
  buildClaudeSubscriptionClient,
  shutdownClaudeSubscription,
} from "../src/main/agent/providers/claude-subscription/client"
import { hostCliEnv } from "../src/main/agent/env/host-cli-env"
import {
  resolveExecutable,
  compatibleVersion,
} from "../src/main/agent/providers/claude-subscription/setup"
import { captureProcess } from "../src/main/agent/env/spawn-util"
import { windowsPrivatePath } from "../src/main/agent/providers/claude-subscription/windows-state"

const fixture = { origin: "", relay: undefined as any }
;(globalThis as any).__qualification = fixture
const root = process.env.NS_QUALIFICATION_ROOT!
app.setPath("userData", join(root, "electron-user-data"))
const results: string[] = []
let requests = 0
let sockets = 0
let captured: any
let stall = false
const server = createServer(async (req, res) => {
  assert.ok(req.url?.startsWith("/v1/messages"))
  requests++
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  captured = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_fixture",
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
  res.writeHead(200, { "content-type": "text/event-stream" })
  const wire = (stall ? events.slice(0, 3) : events)
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("")
  if (stall) res.write(wire)
  else res.end(wire)
})
server.on("connection", (socket) => {
  sockets++
  socket.once("close", () => sockets--)
})
async function waitFor(check: () => Promise<void> | void) {
  const deadline = Date.now() + 15000
  while (true) {
    try {
      await check()
      return
    } catch (error) {
      if (Date.now() > deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}
async function clean() {
  await waitFor(async () => {
    assert.deepEqual(
      await readdir(join(root, "claude-subscription-transport")),
      ["cwd"]
    )
    assert.equal(sockets, 0)
  })
  assert.deepEqual(
    await readdir(join(root, "claude-subscription-transport", "cwd")),
    []
  )
  const url = fixture.relay.baseUrl
  await assert.rejects(fetch(url + "/v1/messages"))
}
const body = {
  model: "claude-sonnet-4-6",
  max_tokens: 512,
  stream: true,
  messages: [
    { role: "user", content: "historical question" },
    { role: "assistant", content: "historical answer" },
    { role: "user", content: "current question" },
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
async function qualify() {
  await app.whenReady()
  assert.equal(app.isPackaged, true)
  assert.equal(process.type, "browser")
  assert.equal(process.platform, "win32")
  assert.ok(app.getAppPath().endsWith("app.asar"))
  await access(join(process.resourcesPath, "qualification-descendant.cjs"))
  results.push("packaged Electron main process, ASAR and extra resource")
  const env = await hostCliEnv()
  const executable = await resolveExecutable(env)
  assert.equal(
    executable,
    await realpath(join(process.env.HOME!, ".local", "bin", "claude.exe"))
  )
  const versionProbe = await captureProcess(
    spawn(executable, ["--version"], {
      env: {
        ...env,
        DISABLE_AUTOUPDATER: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }),
    { timeoutMs: 5000, maxOutputBytes: 4096, killGroup: true }
  )
  assert.equal(versionProbe.exitCode, 0)
  const cliVersion = compatibleVersion(versionProbe.stdout.toString("utf8"))
  results.push(
    "GUI minimal mixed-case Path + synthetic HOME native executable discovery and real version gate"
  )
  await mkdir(join(process.env.HOME!, ".claude"), { recursive: true })
  const marker = join(root, "hook-ran")
  await writeFile(
    join(process.env.HOME!, ".claude", "CLAUDE.md"),
    "NS_PACKAGED_ISOLATION_FIXTURE"
  )
  await writeFile(
    join(process.env.HOME!, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: "command", command: `cmd /c echo fixture > "${marker}"` },
            ],
          },
        ],
      },
    })
  )
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  fixture.origin = `http://127.0.0.1:${(server.address() as any).port}`
  const client = buildClaudeSubscriptionClient({ appData: root })
  const models = await client.models.list()
  assert.ok(models!.data!.length)
  assert.equal(requests, 0)
  assert.equal(fixture.relay.diagnostics().admitted, 0)
  await clean()
  results.push("initialize discovery zero Messages, cleanup")
  for (const streamMode of [false, true]) {
    requests = 0
    const response: any = await client.chat.completions.create({
      ...body,
      stream: streamMode,
    })
    if (streamMode) {
      let text = ""
      for await (const chunk of response)
        text += chunk.choices[0].delta.content || ""
      assert.equal(text, "synthetic response")
    } else
      assert.equal(response.choices[0].message.content, "synthetic response")
    assert.equal(requests, 1)
    assert.equal(fixture.relay.diagnostics().admitted, 1)
    const wire = JSON.stringify(captured)
    for (const text of [
      "historical question",
      "historical answer",
      "current question",
    ])
      assert.ok(wire.includes(text))
    assert.ok(!wire.includes("NS_PACKAGED_ISOLATION_FIXTURE"))
    assert.equal(captured.max_tokens, 512)
    assert.equal(captured.tools.length, 1)
    assert.equal(captured.tools[0].name, "mcp__north_star__probe")
    await assert.rejects(access(marker))
    await clean()
  }
  results.push(
    "stream/nonstream, replay, inert inventory, isolation and one-request admission"
  )
  for (const mode of ["cancel", "return", "shutdown"]) {
    requests = 0
    stall = true
    const controller = new AbortController()
    const stream: any = await client.chat.completions.create(body, undefined, {
      signal: controller.signal,
    })
    await stream.next()
    const pending = stream.next()
    if (mode === "return") {
      await stream.return()
      assert.equal((await pending).done, true)
    } else {
      const rejected = assert.rejects(pending, { name: "AbortError" })
      if (mode === "cancel") controller.abort()
      else shutdownClaudeSubscription()
      await rejected
    }
    await clean()
    assert.equal(requests, 1)
    results.push(
      `${mode}: official CLI, request artifacts and relay/upstream sockets cleaned`
    )
  }
  await windowsPrivatePath(join(root, "claude-subscription-transport"))
  await windowsPrivatePath(join(root, "claude-subscription-transport", "cwd"))
  results.push(
    "native protected private state ACLs (request files verified by production path)"
  )
  const child = spawn(
    process.execPath,
    [join(process.resourcesPath, "qualification-descendant.cjs")],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    }
  )
  const controller = new AbortController()
  const capturedChild = captureProcess(child, {
    signal: controller.signal,
    timeoutMs: 10000,
    maxOutputBytes: 1024,
    killGroup: true,
  })
  const [line] = await once(child.stdout!, "data")
  const descendant = Number(line.toString().trim())
  assert.ok(descendant > 0)
  controller.abort()
  assert.equal((await capturedChild).aborted, true)
  await waitFor(() => {
    assert.throws(() => process.kill(descendant, 0))
  })
  results.push(
    "packaged Electron supervision terminates owned fixture parent and descendant without system Node"
  )
  await writeFile(
    join(root, "result.json"),
    JSON.stringify(
      {
        platform: process.platform,
        arch: process.arch,
        electron: process.versions.electron,
        node: process.versions.node,
        cliVersion,
        packaged: app.isPackaged,
        results,
      },
      null,
      2
    )
  )
}
void qualify().then(
  async () => {
    await fixture.relay?.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    app.exit(0)
  },
  async (error) => {
    console.error("Packaged transport qualification failed:", error)
    shutdownClaudeSubscription()
    await fixture.relay?.close()
    server.closeAllConnections()
    server.close()
    app.exit(1)
  }
)
