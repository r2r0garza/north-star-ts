import type { ClaudeSubscriptionCatalog } from "../../../../shared/claude-subscription"
import { spawn } from "child_process"
import { randomUUID } from "crypto"
import { hostCliEnv } from "../../env/host-cli-env"
import { captureProcess } from "../../env/spawn-util"
import { startAdmission } from "./admission"
import { guardManagedPolicy } from "./managed-policy"
import {
  gatewayEnvironment,
  gatewayRoute,
  gatewayChildEnvironment,
} from "./gateway"
import {
  guardEnvironment,
  privateDirectories,
  resolveExecutable,
  verifyCliCompatibility,
} from "./setup"
import { JsonLines } from "./stream-json"
import { aborted, ClaudeSubscriptionError, object, protocol } from "./errors"

export function parseModelCatalog(value: unknown): Array<{ id: string }> {
  if (!Array.isArray(value) || !value.length || value.length > 256) protocol()
  const ids = new Set<string>()
  for (const model of value) {
    // Fable and its advertised long-context route are not qualified for routing.
    if (
      object(model) &&
      (model.value === "default" ||
        model.value === "fable" ||
        model.value === "claude-fable-5-1[1m]")
    )
      continue
    if (
      !object(model) ||
      typeof model.value !== "string" ||
      !/^(?:claude-[a-z0-9.-]+|sonnet|opus|haiku)$/.test(model.value) ||
      ids.has(model.value)
    )
      protocol()
    ids.add(model.value)
  }
  if (!ids.size) protocol()
  return [...ids].map((id) => ({ id }))
}

export async function discoverClaudeModels(
  appData: string,
  controller: AbortController
): Promise<{ data: Array<{ id: string }> }> {
  const signal = controller.signal
  let files: Awaited<ReturnType<typeof privateDirectories>> | undefined
  let gate: Awaited<ReturnType<typeof startAdmission>> | undefined
  let processResult: ReturnType<typeof captureProcess> | undefined
  let failure: unknown
  const fail = (error: unknown) => {
    failure ??= error
    controller.abort()
  }
  const timeout = setTimeout(
    () =>
      fail(
        new ClaudeSubscriptionError(
          "claude_subscription_discovery_timeout",
          "Claude model discovery timed out; previous and manual model entries should be retained."
        )
      ),
    process.platform === "win32" ? 60000 : 15000
  )
  try {
    if (signal.aborted) throw aborted()
    const env = guardEnvironment(await gatewayEnvironment(await hostCliEnv()))
    const executable = await resolveExecutable(env)
    files = await privateDirectories(appData, signal)
    await verifyCliCompatibility(executable, files.cwd, env, signal)
    const gateway = gatewayRoute(env)
    if (gateway) {
      const model = env.ANTHROPIC_MODEL
      if (!model || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(model))
        throw new ClaudeSubscriptionError(
          "claude_subscription_gateway_unqualified",
          "Gateway discovery requires a configured ANTHROPIC_MODEL; no inference or remote model lookup was attempted."
        )
      return { data: [{ id: model }] }
    }
    gate = await startAdmission({ signal })
    // Never enable this gate: initialization has no permission to generate.
    void gate.response.catch((error) => {
      if (!signal.aborted) fail(error)
    })
    const settings = await files.file(
      "settings.json",
      JSON.stringify({
        disableAllHooks: true,
        enabledPlugins: {
          "cc-plugin-agents-md@builtin": false,
          "cc-plugin-plugin-authoring@builtin": false,
        },
      })
    )
    const mcp = await files.file("mcp.json", JSON.stringify({ mcpServers: {} }))
    const system = await files.file(
      "system.txt",
      "Model catalog discovery only. No generation authorized."
    )
    if (signal.aborted) throw aborted()
    await guardManagedPolicy(env, signal)
    const child = spawn(
      executable,
      [
        "--print",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--tools",
        "",
        "--system-prompt-file",
        system,
        "--settings",
        settings,
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        mcp,
        "--disable-slash-commands",
        "--permission-mode",
        "dontAsk",
        "--no-session-persistence",
      ],
      {
        cwd: files.cwd,
        env: { ...env, ANTHROPIC_BASE_URL: gate.baseUrl },
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      }
    )
    processResult = captureProcess(child, {
      signal,
      timeoutMs: 15000,
      maxOutputBytes: 4096,
      killGroup: true,
    })
    const requestId = randomUUID()
    let models: Array<{ id: string }> | undefined
    const parser = new JsonLines((event) => {
      if (event.type === "control_response") {
        const response = event.response
        if (
          !object(response) ||
          response.request_id !== requestId ||
          response.subtype !== "success" ||
          models
        )
          protocol()
        models = parseModelCatalog(response.response?.models)
        child.stdin.end()
      } else if (
        event.type === "assistant" ||
        event.type === "stream_event" ||
        event.type === "result"
      )
        protocol()
      else if (event.type !== "system") protocol()
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
          "claude_subscription_discovery_input",
          "Claude model discovery input closed unexpectedly."
        )
      )
    )
    child.stdin.write(
      JSON.stringify({
        type: "control_request",
        request_id: requestId,
        request: { subtype: "initialize" },
      }) + "\n"
    )
    const exit = await processResult
    if (failure) throw failure
    if (signal.aborted) throw aborted()
    parser.finish()
    if (
      exit.timedOut ||
      exit.spawnError ||
      exit.exitCode !== 0 ||
      exit.signal ||
      !models ||
      gate.diagnostics().admitted !== 0
    )
      protocol()
    return { data: models }
  } catch (error) {
    if (failure) throw failure
    if (signal.aborted) throw aborted()
    if (error instanceof ClaudeSubscriptionError) throw error
    throw new ClaudeSubscriptionError(
      "claude_subscription_discovery",
      "Claude model discovery failed; previous and manual model entries should be retained."
    )
  } finally {
    clearTimeout(timeout)
    controller.abort()
    await gate?.close()
    if (processResult) await processResult
    await files?.close()
  }
}

// This explicit route passed installed-CLI synthetic routing qualification, not
// live entitlement checks. It deliberately makes no long-context claim.
export const CLAUDE_SUBSCRIPTION_FALLBACK_MODELS = [{ id: "claude-sonnet-4-6" }]

export async function loadClaudeSubscriptionCatalog(
  appData: string,
  previous: Array<{ id: string }> = []
): Promise<ClaudeSubscriptionCatalog> {
  const controller = new AbortController()
  try {
    const catalog = await discoverClaudeModels(appData, controller)
    return {
      source: "discovered",
      models: catalog.data,
      hint: "CLI catalog refreshed without generation. Visibility does not establish model entitlement.",
    }
  } catch {
    return previous.length
      ? {
          source: "retained",
          models: previous,
          hint: "CLI discovery failed. Existing and manual model entries were retained; recheck setup and retry refresh.",
        }
      : {
          source: "fallback",
          models: CLAUDE_SUBSCRIPTION_FALLBACK_MODELS.map((model) => ({
            ...model,
          })),
          hint: "CLI discovery failed. Using a synthetically qualified reference route, not a verified entitlement list. Manual IDs remain available.",
        }
  } finally {
    controller.abort()
  }
}
