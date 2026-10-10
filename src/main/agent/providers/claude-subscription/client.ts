import {
  nativeAssistant,
  validateCarrier,
  historyFingerprint,
} from "./native-carrier"
import { spawn, type ChildProcessWithoutNullStreams } from "child_process"
import { randomUUID } from "crypto"
import { once } from "events"
import type { LlmClient } from "../index"
import { hostCliEnv } from "../../env/host-cli-env"
import { captureProcess } from "../../env/spawn-util"
import { startAdmission } from "./admission"
import { startInventory } from "./mcp"
import { validateRequest, type ValidatedRequest } from "./request"
import {
  guardEnvironment,
  privateDirectories,
  resolveExecutable,
  verifyCliCompatibility,
} from "./setup"
import { JsonLines } from "./stream-json"
import {
  withWindowsProbeWorker,
  closeWindowsProbeWorker,
} from "./windows-state"
import { aborted, ClaudeSubscriptionError, protocol } from "./errors"
import type { CapturedResponse } from "./sse"
import { discoverClaudeModels } from "./model-catalog"

export interface TransportOptions {
  appData: string
}

export function buildInvocation(
  request: ValidatedRequest,
  files: { system: string; settings: string; mcp: string }
): string[] {
  return [
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
    request.model,
    "--system-prompt-file",
    files.system,
    "--settings",
    files.settings,
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    files.mcp,
    "--disable-slash-commands",
    "--max-turns",
    "1",
    "--permission-mode",
    "dontAsk",
    "--no-session-persistence",
    ...(request.effort === undefined
      ? []
      : ["--effort", String(request.effort)]),
  ]
}

class ChunkQueue implements AsyncIterableIterator<Record<string, unknown>> {
  private chunks: Record<string, unknown>[] = []
  private waiter?: {
    resolve: (value: IteratorResult<Record<string, unknown>>) => void
    reject: (error: unknown) => void
  }
  private done = false
  private error: unknown
  private size = 0
  constructor(private readonly cancel: () => void) {}
  [Symbol.asyncIterator]() {
    return this
  }
  push(chunk: Record<string, unknown>) {
    if (this.done) return
    const bytes = Buffer.byteLength(JSON.stringify(chunk))
    this.size += bytes
    if (this.size > 32 * 1024 * 1024) {
      this.cancel()
      this.finish(
        new ClaudeSubscriptionError(
          "claude_subscription_consumer_stalled",
          "Subscription stream consumer stopped reading."
        )
      )
      return
    }
    if (this.waiter) {
      const waiter = this.waiter
      this.waiter = undefined
      this.size -= bytes
      waiter.resolve({ done: false, value: chunk })
    } else this.chunks.push(chunk)
  }
  finish(error?: unknown) {
    if (this.done) return
    this.done = true
    this.error = error
    if (error) {
      this.chunks = []
      this.size = 0
    }
    if (this.waiter) {
      const waiter = this.waiter
      this.waiter = undefined
      if (error) waiter.reject(error)
      else waiter.resolve({ done: true, value: undefined })
    }
  }
  next(): Promise<IteratorResult<Record<string, unknown>>> {
    const value = this.chunks.shift()
    if (value) {
      this.size -= Buffer.byteLength(JSON.stringify(value))
      return Promise.resolve({ done: false, value })
    }
    if (this.done)
      return this.error
        ? Promise.reject(this.error)
        : Promise.resolve({ done: true, value: undefined })
    if (this.waiter)
      return Promise.reject(
        new Error("Concurrent stream reads are not supported.")
      )
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject }
    })
  }
  return(): Promise<IteratorResult<Record<string, unknown>>> {
    this.cancel()
    this.chunks = []
    this.size = 0
    this.finish()
    return Promise.resolve({ done: true, value: undefined })
  }
}

const active = new Set<AbortController>()
export function shutdownClaudeSubscription(): void {
  for (const controller of active) controller.abort()
}

export function buildClaudeSubscriptionClient(
  options: TransportOptions
): LlmClient {
  return {
    compatibilityProbes: false,
    chat: {
      completions: {
        create: (body, ...rest) => {
          const request = validateRequest(body)
          const positional = rest[1] as { signal?: AbortSignal } | undefined
          const controller = new AbortController()
          const signal = positional?.signal
          const onAbort = () => controller.abort()
          if (signal?.aborted) controller.abort()
          else signal?.addEventListener("abort", onAbort, { once: true })
          const queue = new ChunkQueue(() => controller.abort())
          active.add(controller)
          const run = withWindowsProbeWorker(controller.signal, () =>
            execute(request, options, controller, (kind, text) => {
              if (request.stream && text)
                queue.push({
                  choices: [
                    {
                      index: 0,
                      delta: {
                        [kind === "text" ? "content" : "reasoning_content"]:
                          text,
                      },
                      finish_reason: null,
                    },
                  ],
                })
            })
          ).finally(() => {
            active.delete(controller)
            signal?.removeEventListener("abort", onAbort)
          })
          if (!request.stream)
            return run.then((result) => completion(request, result))
          void run.then(
            (result) => {
              const value = completion(request, result)
              const message = value.choices[0].message
              queue.push({
                id: result.id,
                choices: [
                  {
                    index: 0,
                    delta: {
                      [nativeAssistant]: message[nativeAssistant],
                      ...(message.tool_calls.length
                        ? {
                            tool_calls: message.tool_calls.map(
                              (tool, index) => ({ ...tool, index })
                            ),
                          }
                        : {}),
                      ...(message.refusal ? { refusal: message.refusal } : {}),
                    },
                    finish_reason: value.choices[0].finish_reason,
                  },
                ],
                usage: result.usage,
              })
              queue.finish()
            },
            (error) => queue.finish(error)
          )
          return Promise.resolve(queue)
        },
      },
    },
    models: {
      list: async () => {
        const controller = new AbortController()
        active.add(controller)
        try {
          return await discoverClaudeModels(options.appData, controller)
        } finally {
          active.delete(controller)
        }
      },
    },
  }
}

function completion(request: ValidatedRequest, result: CapturedResponse) {
  const toolCalls = result.tools.map((tool) => {
    const name = request.names.get(tool.name)
    if (
      !name ||
      (request.extraBody.tool_choice &&
        (request.extraBody.tool_choice as any).type === "none")
    )
      protocol()
    return {
      id: tool.id as string,
      type: "function" as const,
      function: { name, arguments: JSON.stringify(tool.input) },
    }
  })
  return {
    id: result.id,
    object: "chat.completion",
    model: request.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          [nativeAssistant]: validateCarrier({
            version: 1,
            provider: "claude_subscription",
            model: request.model,
            prefix: historyFingerprint(request.frames),
            blocks: result.blocks,
          }),
          content: result.text,
          reasoning_content: result.reasoning,
          tool_calls: toolCalls,
          ...(result.stop === "refusal"
            ? { refusal: result.text || "Claude declined the request." }
            : {}),
        },
        finish_reason:
          result.stop === "tool_use"
            ? "tool_calls"
            : ["max_tokens", "model_context_window_exceeded"].includes(
                  result.stop
                )
              ? "length"
              : result.stop === "refusal"
                ? "refusal"
                : "stop",
      },
    ],
    usage: result.usage,
  }
}

async function execute(
  request: ValidatedRequest,
  options: TransportOptions,
  controller: AbortController,
  emit: (kind: "text" | "reasoning", text: string) => void
): Promise<CapturedResponse> {
  const signal = controller.signal
  const started = performance.now()
  let checkpoint = started
  const startupMs: Record<string, number> = {}
  const stage = (name: string) => {
    const now = performance.now()
    startupMs[name] = Math.round(now - checkpoint)
    checkpoint = now
  }
  let firstDelta = false
  let files: Awaited<ReturnType<typeof privateDirectories>> | undefined
  let inventory: Awaited<ReturnType<typeof startInventory>> | undefined
  let relay: Awaited<ReturnType<typeof startAdmission>> | undefined
  let child: ChildProcessWithoutNullStreams | undefined
  let supervised: ReturnType<typeof captureProcess> | undefined
  let idle: ReturnType<typeof setTimeout> | undefined
  const auxiliary = !request.stream
    ? setTimeout(() => controller.abort(), 300000)
    : undefined
  let failure: unknown
  const fail = (error: unknown) => {
    failure ??= error
    controller.abort()
  }
  const heartbeat = () => {
    clearTimeout(idle)
    idle = setTimeout(
      () =>
        fail(
          new ClaudeSubscriptionError(
            "claude_subscription_stalled",
            "Claude subscription transport stopped responding."
          )
        ),
      180000
    )
  }
  try {
    if (signal.aborted) throw aborted()
    const env = guardEnvironment(await hostCliEnv())
    const executable = await resolveExecutable(env)
    if (signal.aborted) throw aborted()
    stage("environment")
    files = await privateDirectories(options.appData, signal)
    stage("privateDirectories")
    await verifyCliCompatibility(executable, files.cwd, env, signal)
    stage("compatibility")
    inventory = await startInventory(request.tools)
    relay = await startAdmission({
      signal,
      frames: request.frames,
      onDelta: (kind, text) => {
        if (!firstDelta) {
          firstDelta = true
          stage("nativeStartupAndUpstream")
          console.debug("[claude-subscription] startup", {
            ...startupMs,
            firstDeltaMs: Math.round(performance.now() - started),
          })
        }
        heartbeat()
        emit(kind, text)
      },
    })
    const artifacts = [
      { name: "system.txt", value: request.system },
      { name: "mcp.json", value: JSON.stringify(inventory.config) },
    ]
    // Native fixed thinking has a 1024-token minimum, larger than cheap
    // auxiliary caps. Keep those caps usable without increasing paid output.
    const settingsValue = JSON.stringify({
      env: {
        CLAUDE_CODE_EXTRA_BODY: JSON.stringify(request.extraBody),
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(request.maxTokens),
        ...(request.maxTokens < 1024 ? { MAX_THINKING_TOKENS: "0" } : {}),
      },
      disableAllHooks: true,
      enabledPlugins: {
        "cc-plugin-agents-md@builtin": false,
        "cc-plugin-plugin-authoring@builtin": false,
      },
      enableAllProjectMcpServers: false,
    })
    const [system, mcp, settings] = await files.files([
      ...artifacts,
      { name: "settings.json", value: settingsValue },
      { name: "manifest.json", value: JSON.stringify(request.tools) },
    ])
    if (signal.aborted) throw aborted()
    await closeWindowsProbeWorker()
    stage("inventoryAndFiles")
    child = spawn(
      executable,
      buildInvocation(request, { system, settings, mcp }),
      {
        cwd: files.cwd,
        env: {
          ...env,
          ANTHROPIC_BASE_URL: relay.baseUrl,
          CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(request.maxTokens),
        },
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      }
    )
    supervised = captureProcess(child, {
      signal,
      timeoutMs: 2147483647,
      maxOutputBytes: 4096,
      killGroup: true,
    })
    heartbeat()
    let initialized = false
    let initInventory: string | undefined
    let finalQuery = false
    let replay = false
    let ack: (() => void) | undefined
    let final: Record<string, any> | undefined
    let nativeText: string | undefined
    const parser = new JsonLines((event) => {
      heartbeat()
      if (event.type === "system" && event.subtype === "init") {
        const inventoryState = JSON.stringify({
          tools: event.tools,
          skills: event.skills,
          plugins: event.plugins,
          agents: event.agents,
          mcp_servers: event.mcp_servers,
        })
        if (initInventory !== undefined && initInventory !== inventoryState)
          protocol()
        if (
          !Array.isArray(event.tools) ||
          event.tools.some(
            (name: unknown) =>
              typeof name !== "string" || !request.names.has(name)
          ) ||
          !Array.isArray(event.skills) ||
          event.skills.length ||
          !Array.isArray(event.plugins) ||
          event.plugins.length ||
          !Array.isArray(event.agents) ||
          event.agents.some(
            (name: unknown) =>
              ![
                "claude",
                "Explore",
                "general-purpose",
                "Plan",
                "statusline-setup",
              ].includes(String(name))
          ) ||
          !Array.isArray(event.mcp_servers) ||
          event.mcp_servers.some(
            (server: any) =>
              !Object.hasOwn(inventory!.config.mcpServers, server?.name) ||
              server?.status !== "connected"
          )
        ) {
          throw new ClaudeSubscriptionError(
            "claude_subscription_isolation",
            "Claude initialized with an unexpected native tool, skill, plugin or MCP inventory."
          )
        }
        initInventory = inventoryState
        initialized = true
        if (finalQuery) relay!.enable()
      } else if (event.type === "result") {
        if (replay) {
          if (
            event.is_error !== false ||
            event.num_turns !== 0 ||
            event.subtype !== "success"
          )
            protocol()
          const done = ack
          ack = undefined
          if (!done) protocol()
          done()
        } else {
          if (!finalQuery || final) protocol()
          final = event
        }
      } else if (event.type === "assistant") {
        if (replay || !finalQuery || final) protocol()
        if (!Array.isArray(event.message?.content)) protocol()
        const text = event.message.content
          .filter((block: any) => block.type === "text")
          .map((block: any) => block.text)
        if (text.some((value: unknown) => typeof value !== "string")) protocol()
        nativeText = (nativeText ?? "") + text.join("")
      } else if (event.type === "stream_event") {
        if (replay || !finalQuery || final) protocol()
      } else if (
        ![
          "system",
          "user",
          "rate_limit_event",
          "tool_progress",
          "tool_use_summary",
          "control_response",
        ].includes(event.type)
      )
        protocol()
    })
    child.stdout.on("data", (chunk) => {
      try {
        parser.push(chunk)
      } catch (error) {
        fail(error)
      }
    })
    child.stdin.on("error", () =>
      fail(
        new ClaudeSubscriptionError(
          "claude_subscription_stdin",
          "Claude subscription replay input closed unexpectedly."
        )
      )
    )
    child.once("error", () =>
      fail(
        new ClaudeSubscriptionError(
          "claude_subscription_cli_start",
          "Could not start the official Claude executable."
        )
      )
    )
    const exited = supervised.then((value) => {
      if (!signal.aborted) {
        try {
          parser.finish()
        } catch (error) {
          fail(error)
        }
      }
      if (!final && !signal.aborted)
        fail(
          new ClaudeSubscriptionError(
            "claude_subscription_early_exit",
            "Claude exited without a final result."
          )
        )
      if (relay!.diagnostics().admitted === 0 && !signal.aborted)
        fail(
          new ClaudeSubscriptionError(
            "claude_subscription_no_response",
            "Claude exited without an admitted model response."
          )
        )
      return value
    })
    void relay.response.catch(fail)
    const sessionId = randomUUID()
    const write = async (frame: unknown) => {
      if (signal.aborted) throw failure ?? aborted()
      if (
        !child!.stdin.write(
          JSON.stringify({
            ...(frame as object),
            session_id: sessionId,
            parent_tool_use_id: null,
          }) + "\n"
        )
      )
        await once(child!.stdin, "drain", { signal })
    }
    for (const frame of request.frames.slice(0, -1)) {
      replay = true
      if (frame.type === "assistant") {
        await write(frame)
        continue
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const acknowledged = new Promise<void>((resolve, reject) => {
        ack = resolve
        timer = setTimeout(
          () =>
            reject(
              new ClaudeSubscriptionError(
                "claude_subscription_replay_timeout",
                "Claude did not acknowledge historical replay."
              )
            ),
          30000
        )
      })
      try {
        await write(frame)
        await Promise.race([
          acknowledged,
          exited.then(() => {
            throw (
              failure ??
              new ClaudeSubscriptionError(
                "claude_subscription_early_exit",
                "Claude exited during replay."
              )
            )
          }),
        ])
      } finally {
        clearTimeout(timer)
        ack = undefined
      }
    }
    replay = false
    finalQuery = true
    if (initialized) relay.enable()
    await write(request.frames.at(-1))
    child.stdin.end()
    const result = await relay.response
    const exit = await exited
    if (failure) throw failure
    if (signal.aborted || exit.aborted) throw aborted()
    if (!final || exit.signal || exit.spawnError) protocol()
    const acceptedToolBoundary =
      result.stop === "tool_use" &&
      final.subtype === "error_max_turns" &&
      final.is_error === true &&
      final.num_turns === 2 &&
      exit.exitCode === 1
    const ordinary =
      final.subtype === "success" &&
      final.is_error === false &&
      final.num_turns === 1 &&
      exit.exitCode === 0
    // The CLI replaces partial text with its denied output-limit recovery error;
    // only the completed first response remains authoritative at this boundary.
    const acceptedOutputBoundary =
      result.stop === "max_tokens" &&
      result.text.length > 0 &&
      final.subtype === "success" &&
      final.is_error === true &&
      final.num_turns === 2 &&
      exit.exitCode === 1 &&
      relay.diagnostics().recoveryBlocked > 0
    if (!ordinary && !acceptedToolBoundary && !acceptedOutputBoundary)
      throw new ClaudeSubscriptionError(
        "claude_subscription_protocol",
        `Claude completion boundary was not accepted (stop ${result.stop}, subtype ${String(
          final.subtype
        )
          .replace(/[^a-z_]/g, "")
          .slice(
            0,
            64
          )}, turns ${Number(final.num_turns)}, error ${final.is_error === true}, exit ${exit.exitCode}).`
      )
    if (
      !acceptedOutputBoundary &&
      nativeText !== undefined &&
      nativeText !== result.text
    )
      throw new ClaudeSubscriptionError(
        "claude_subscription_protocol",
        `Claude assistant text differs from the captured response (native ${nativeText.length}, captured ${result.text.length} characters).`
      )
    if (
      ordinary &&
      typeof final.result === "string" &&
      final.result !== result.text
    )
      throw new ClaudeSubscriptionError(
        "claude_subscription_protocol",
        `Claude final text differs from the captured response (native ${final.result.length}, captured ${result.text.length} characters).`
      )
    // Validate names before returning any executable calls, even for nonstream callers.
    completion(request, result)
    return result
  } catch (error) {
    if (failure) throw failure
    if (signal.aborted) throw aborted()
    if (error instanceof ClaudeSubscriptionError) throw error
    throw new ClaudeSubscriptionError(
      "claude_subscription_setup",
      "Claude subscription transport could not initialize its private request state."
    )
  } finally {
    clearTimeout(idle)
    clearTimeout(auxiliary)
    controller.abort()
    child?.stdin.destroy()
    await relay?.close()
    await inventory?.close()
    if (supervised) await supervised
    await files?.close()
  }
}
