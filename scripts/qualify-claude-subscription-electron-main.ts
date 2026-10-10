import { app } from "electron"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { once } from "node:events"
import {
  mkdir,
  readdir,
  writeFile,
  access,
  realpath,
  lstat,
  readFile,
  rm,
} from "node:fs/promises"
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
import { guardManagedPolicy } from "../src/main/agent/providers/claude-subscription/managed-policy"

const linux = process.platform === "linux"

const fixture = { origin: "", relay: undefined as any }
;(globalThis as any).__qualification = fixture
const root = process.env.NS_QUALIFICATION_ROOT!
app.setPath("userData", join(root, "electron-user-data"))
const results: string[] = []
let requests = 0
let sockets = 0
let captured: any
let stall = false
let recoveryStop = ""
let toolMode = false
async function privateState(path: string, directory: boolean) {
  const stat = await lstat(path)
  assert.equal(stat.isSymbolicLink(), false)
  assert.equal(stat.isDirectory(), directory)
  assert.equal(stat.uid, process.getuid!())
  assert.equal(stat.mode & 0o777, directory ? 0o700 : 0o600)
}
async function inspectRequestFiles() {
  const transport = join(root, "claude-subscription-transport")
  await privateState(transport, true)
  await privateState(join(transport, "cwd"), true)
  const directories = (await readdir(transport)).filter(
    (name) => name !== "cwd"
  )
  assert.equal(directories.length, 1)
  for (const name of directories) {
    const directory = join(transport, name)
    await privateState(directory, true)
    const files = await readdir(directory)
    assert.ok(files.length >= 3)
    for (const file of files) await privateState(join(directory, file), false)
  }
}
const server = createServer(async (req, res) => {
  assert.ok(req.url?.startsWith("/v1/messages"))
  requests++
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  captured = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  if (linux) await inspectRequestFiles()
  const events: any[] = [
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
  if (recoveryStop) {
    events[2].delta.text = ""
    events[4].delta.stop_reason = recoveryStop
  }
  if (toolMode) {
    events[1].content_block = {
      type: "tool_use",
      id: "tool_fixture",
      name: "mcp__north_star__probe",
      input: {},
    }
    events[2].delta = { type: "input_json_delta", partial_json: "{}" }
    events[4].delta.stop_reason = "tool_use"
  }
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
  const inventory = (fixture as any).inventory
  if (inventory)
    await assert.rejects(fetch(inventory.config.mcpServers.north_star.url))
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
  assert.ok(["win32", "linux"].includes(process.platform))
  assert.ok(app.getAppPath().endsWith("app.asar"))
  await access(join(process.resourcesPath, "qualification-descendant.cjs"))
  results.push("packaged Electron main process, ASAR and extra resource")
  const env = await hostCliEnv()
  const executable = await resolveExecutable(env)
  assert.equal(
    executable,
    await realpath(
      join(process.env.HOME!, ".local", "bin", linux ? "claude" : "claude.exe")
    )
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
    "GUI minimal PATH + synthetic HOME native executable discovery and real version gate"
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
              {
                type: "command",
                command: linux
                  ? `printf fixture > "${marker}"`
                  : `cmd /c echo fixture > "${marker}"`,
              },
            ],
          },
        ],
      },
    })
  )
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  fixture.origin = `http://127.0.0.1:${(server.address() as any).port}`
  const client = buildClaudeSubscriptionClient({ appData: root })
  if (linux) {
    await guardManagedPolicy(env, new AbortController().signal)
    await assert.rejects(
      guardManagedPolicy(
        { ...env, WSL_INTEROP: "synthetic" },
        new AbortController().signal
      ),
      { code: "claude_subscription_platform_unqualified" }
    )
    const policy = join(process.env.HOME!, ".claude", "remote-settings.json")
    await writeFile(policy, "synthetic policy presence", { mode: 0o600 })
    try {
      await assert.rejects(client.models.list(), {
        code: "claude_subscription_managed_policy",
      })
      const blocked: any = await client.chat.completions.create(body)
      await assert.rejects(
        async () => {
          for await (const _ of blocked) {
          }
        },
        { code: "claude_subscription_managed_policy" }
      )
      assert.equal(requests, 0)
      assert.equal(fixture.relay, undefined)
    } finally {
      await rm(policy)
    }
    results.push(
      "native Linux presence-only policy checks; synthetic remote cache blocks discovery/generation before listeners; WSL rejected"
    )
  }
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
  if (linux) {
    for (const streamMode of [false, true]) {
      toolMode = true
      requests = 0
      const response: any = await client.chat.completions.create({
        ...body,
        stream: streamMode,
      })
      if (streamMode) {
        const chunks: any[] = []
        for await (const chunk of response) chunks.push(chunk)
        assert.equal(
          chunks.at(-1).choices[0].delta.tool_calls[0].function.name,
          "probe"
        )
      } else
        assert.equal(
          response.choices[0].message.tool_calls[0].function.name,
          "probe"
        )
      assert.equal(requests, 1)
      await clean()
      toolMode = false
      for (const stop of ["end_turn", "max_tokens"]) {
        recoveryStop = stop
        requests = 0
        await assert.rejects(
          async () => {
            const response: any = await client.chat.completions.create({
              ...body,
              stream: streamMode,
            })
            if (streamMode)
              for await (const chunk of response)
                assert.ok(!chunk.choices[0].delta.tool_calls?.length)
          },
          { code: "claude_subscription_protocol" }
        )
        assert.equal(requests, 1)
        assert.equal(fixture.relay.diagnostics().admitted, 1)
        assert.equal(fixture.relay.diagnostics().recoveryBlocked, 1)
        await clean()
      }
      recoveryStop = ""
    }
    results.push(
      "stream/nonstream tool boundary; all four empty-text denied recoveries: one admitted, recoveryBlocked=1, protocol rejection, no executable calls"
    )
  }
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
  if (!linux) {
    await windowsPrivatePath(join(root, "claude-subscription-transport"))
    await windowsPrivatePath(join(root, "claude-subscription-transport", "cwd"))
    results.push(
      "native protected private state ACLs (request files verified by production path)"
    )
  } else
    results.push(
      "0700 owner directories and 0600 owner request files inspected during actual inference"
    )
  for (const termination of linux ? ["abort", "timeout"] : ["abort"]) {
    const child = spawn(
      process.execPath,
      [join(process.resourcesPath, "qualification-descendant.cjs")],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        detached: linux,
        stdio: ["ignore", "pipe", "pipe"],
      }
    )
    const controller = new AbortController()
    const capturedChild = captureProcess(child, {
      signal: controller.signal,
      timeoutMs: termination === "timeout" ? 500 : 10000,
      maxOutputBytes: 1024,
      killGroup: true,
    })
    const [line] = await once(child.stdout!, "data")
    const descendant = Number(line.toString().trim())
    assert.ok(descendant > 0)
    if (termination === "abort") controller.abort()
    const childResult = await capturedChild
    assert.equal(
      termination === "abort" ? childResult.aborted : childResult.timedOut,
      true
    )
    await waitFor(async () => {
      if (linux) {
        let state: string | undefined
        try {
          state = (await readFile(`/proc/${descendant}/stat`, "utf8"))
            .split(") ")[1]
            ?.split(" ")[0]
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
        assert.ok(state === undefined || state === "Z")
      } else assert.throws(() => process.kill(descendant, 0))
      assert.throws(() => process.kill(child.pid!, 0))
    })
    results.push(
      `packaged Electron ${termination} supervision terminates owned fixture parent and descendant without system Node`
    )
  }
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
