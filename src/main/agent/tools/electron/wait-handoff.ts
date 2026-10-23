import { TOOL_EFFECTS, type AskResult, type Tool, type ToolContext } from "../types"
import { toolError } from "../output"
import { WAIT_MAX_MS, type WaitCondition } from "../../../electron-apps/window-control"
import { NO_ELECTRON, electronError, renderSessions, sessionIdArg } from "./shared"

const KINDS = ["load", "text", "text_gone", "ref_gone", "url", "title", "window_count"] as const

export function parseWait(args: Record<string, unknown>): WaitCondition | string {
  const text = typeof args.text === "string" && args.text ? args.text.slice(0, 500) : null
  const contains = typeof args.contains === "string" && args.contains ? args.contains.slice(0, 500) : null
  const count = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 100 ? v : undefined)
  switch (args.kind) {
    case "load":
      return { kind: "load" }
    case "text":
    case "text_gone":
      return text ? { kind: args.kind, text } : "`text` is required."
    case "ref_gone":
      return typeof args.ref === "string" ? { kind: "ref_gone", ref: args.ref } : "`ref` is required."
    case "url":
    case "title":
      return contains ? { kind: args.kind, contains } : "`contains` is required."
    case "window_count": {
      const atLeast = count(args.atLeast)
      const atMost = count(args.atMost)
      return atLeast === undefined && atMost === undefined
        ? "`atLeast` and/or `atMost` (0–100) is required."
        : { kind: "window_count", atLeast, atMost }
    }
    default:
      return `\`kind\` must be one of ${KINDS.join(", ")}.`
  }
}

export const electronWaitTool: Tool = {
  effects: TOOL_EFFECTS.readOnlySequential,
  executionPolicy: { timeoutMs: WAIT_MAX_MS + 10_000 },
  definition: {
    type: "function",
    function: {
      name: "electron_wait",
      description:
        "Wait, polled by the host, until a condition holds in an Electron app " +
        "session: load (document complete), text / text_gone (accessible text " +
        "in the selected window), ref_gone (a snapshot ref's element is " +
        "removed), url / title (contains), or window_count (atLeast/atMost). " +
        "No code. Fails with wait_timeout after timeout_ms (default 10000, max 30000).",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          kind: { type: "string", enum: [...KINDS] },
          text: { type: "string" },
          ref: { type: "string" },
          contains: { type: "string" },
          atLeast: { type: "number" },
          atMost: { type: "number" },
          timeout_ms: { type: "number" },
        },
        required: ["sessionId", "kind"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx: ToolContext) => {
    if (!ctx.electron) return NO_ELECTRON
    const sessionId = sessionIdArg(args)
    if (!sessionId) return toolError("bad_args", "A `sessionId` is required.")
    const condition = parseWait(args)
    if (typeof condition === "string") return toolError("bad_args", condition)
    const timeout = typeof args.timeout_ms === "number" ? args.timeout_ms : 10_000
    try {
      return JSON.stringify(await ctx.electron.wait(sessionId, condition, timeout), null, 2)
    } catch (error) {
      return electronError(error)
    }
  },
}

// Pause for something only the user can do in the app (sign-in, a native
// dialog or menu, an OS permission prompt). Automated interaction with the
// session is refused until the user hands control back.
export const electronHandoffTool: Tool = {
  effects: TOOL_EFFECTS.openWorldMutation,
  definition: {
    type: "function",
    function: {
      name: "electron_handoff",
      description:
        "Hand an Electron app session to the user for a step only a human can " +
        "do (sign-in, a native dialog or menu, an OS prompt). Brings the app " +
        "window forward and PAUSES until the user confirms. Afterwards all refs " +
        "are stale: check electron_status and take a new snapshot.",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          reason: { type: "string", description: "What the user needs to do; shown to them." },
        },
        required: ["sessionId", "reason"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx: ToolContext) => {
    if (!ctx.electron) return NO_ELECTRON
    const sessionId = sessionIdArg(args)
    if (!sessionId) return toolError("bad_args", "A `sessionId` is required.")
    if (!ctx.ask)
      return toolError("unavailable", "Handing off to the user isn't available in this context.")
    const reason =
      typeof args.reason === "string" && args.reason.trim()
        ? args.reason.trim().slice(0, 300)
        : "Complete a step in the app that requires a human"
    let front: Awaited<ReturnType<typeof ctx.electron.beginHandoff>>
    try {
      front = await ctx.electron.beginHandoff(sessionId)
    } catch (error) {
      return electronError(error)
    }
    let answer: AskResult
    try {
      answer = await ctx.ask([
        {
          question: `The test app needs you: ${reason}. ${front ? "Its window was brought forward. " : ""}Do what's needed in the app, then choose an option below.`,
          header: "App handoff",
          options: [
            { label: "Done — continue", description: "I've finished; pick up from here." },
            { label: "I couldn't complete it", description: "Stop trying to proceed past this step." },
          ],
        },
      ])
    } catch (error) {
      await ctx.electron.endHandoff(sessionId).catch(() => null)
      throw error
    }
    // Control returns to the agent with fresh state.
    const status = await ctx.electron.endHandoff(sessionId).catch(() => null)
    const fresh = status ? `\n${renderSessions([status])}` : ""
    if (answer.status === "cancelled")
      return toolError("cancelled", "The user dismissed the handoff without responding.") + fresh
    const selected = answer.answers[0]?.selected?.[0] ?? ""
    const note = answer.answers[0]?.other?.trim()
    if (selected.startsWith("I couldn't"))
      return `The user could not complete the step${note ? `: ${note}` : "."} Do not keep trying to get past it.${fresh}`
    return `The user completed the step${note ? ` (they noted: ${note})` : ""}. Earlier refs are stale; take a new electron_snapshot.${fresh}`
  },
}
