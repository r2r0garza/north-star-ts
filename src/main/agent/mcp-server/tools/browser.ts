import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { browserTools } from "../../tools"
import type { ToolImage } from "../../tools/types"
import type { Gate } from "../../approval/types"
import { askUser } from "../../questions/broker"
import { normalizeQuestions } from "../../questions/normalize"
import type { CliMcpGrant } from "../types"

// The agent browser, exposed to CLI providers that have no browser of their own.
// An explicit allowlist of exactly the tools in `browserTools` — never a blanket
// runTool() passthrough — and each one runs against a context built here that
// carries ONLY a browser, a gate, a question channel, and the turn's signal. No
// filesystem, shell, environment, delegation, or Process capability is reachable
// through it, whatever a tool might ask for.

export const BROWSER_MCP_TOOL_NAMES = browserTools.map(
  (tool) => tool.definition.function.name
)

// Schemas are read from the internal tool definitions rather than restated, so
// the MCP surface cannot drift from the tool it actually calls. Descriptions are
// carried over verbatim: unlike ask_user_question — where both CLIs already had
// a way to ask the user and needed pushing toward ours — neither CLI has a
// browser at all, so there is no competing habit to overcome. If they turn out
// to under-use these, the ask_user_question playbook applies (blunter copy, then
// --append-system-prompt).
const READ_ONLY = new Set([
  "browser_snapshot",
  "browser_screenshot",
  "browser_console",
  "browser_network",
])

export const browserMcpTools = browserTools.map((tool) => ({
  name: tool.definition.function.name,
  description: tool.definition.function.description,
  inputSchema: tool.definition.function.parameters as {
    type: "object"
    [key: string]: unknown
  },
  annotations: {
    // browser_snapshot/screenshot/console/network only observe; the rest drive a
    // real browser someone may be watching.
    readOnlyHint: READ_ONLY.has(tool.definition.function.name),
    openWorldHint: true,
  },
}))

const byName = new Map(
  browserTools.map((tool) => [tool.definition.function.name, tool])
)

function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true }
}

// A CLI turn IS the user's pre-approval: choosing the Claude Code or Codex
// provider means running in auto mode, so North Star never raises an approval
// card for it (plan 034, "always auto — there is no interactive posture").
// This mirrors runAgentLoop's `autoMode` branch, minus the policy call: no
// browser action classifies as `hard_block` today (BrowserActionClassifier emits
// only allow / require_approval / require_explicit_approval), so consulting the
// engine could not change any outcome, and skipping it keeps the bridge off the
// allowlist table. If a browser hard_block is ever added, this gate must start
// calling policy.decide and honor it.
const autoApprove: Gate = () => Promise.resolve("approved")

export async function callBrowserTool(
  name: string,
  args: unknown,
  grant: CliMcpGrant
): Promise<CallToolResult> {
  const tool = byName.get(name)
  if (!tool) return fail(`Unknown tool: ${name}`)

  const sink = grant.browser
  if (!sink) {
    return fail("The agent browser isn't available for this turn.")
  }
  if (sink.signal.aborted) {
    return fail("The turn was stopped before the browser call could run.")
  }

  // browser_screenshot hands its image to the loop out of band; collect it here
  // and return it as a real MCP image block instead of the "can't display
  // images" fallback the tool would otherwise take.
  const images: ToolImage[] = []

  let text: string
  try {
    text = await tool.execute((args ?? {}) as Record<string, unknown>, {
      workspace: grant.workspace ?? "",
      conversationId: grant.conversationId,
      browser: sink.browser,
      gate: autoApprove,
      signal: sink.signal,
      emitImage: (image: ToolImage) => {
        if (!sink.signal.aborted) images.push(image)
      },
      // browser_handoff pauses for a human (captcha, login, 2FA). Available
      // only when this turn also has a question channel; without one the tool
      // reports itself unavailable rather than hanging.
      ask: grant.question
        ? (questions) => {
            const normalized = normalizeQuestions(questions)
            return askUser({
              conversationId: grant.conversationId,
              toolCallId: `north-star-mcp-browser-${name}`,
              questions: normalized.ok ? normalized.questions : questions,
              emit: grant.question!.emit,
              signal: grant.question!.signal,
            })
          }
        : undefined,
    })
  } catch (error) {
    // Never leak a stack trace or absolute path to the client.
    console.error(`[mcp-bridge] ${name} failed:`, error)
    return fail(`${name} failed.`)
  }

  const content: CallToolResult["content"] = [{ type: "text", text }]
  for (const image of images) {
    content.push({
      type: "image",
      data: image.jpegBase64,
      mimeType: "image/jpeg",
    })
  }
  // The internal tools encode failure in their result string (toolError), which
  // has no MCP equivalent, so surface it as isError too.
  return { content, isError: text.startsWith("ERROR[") || undefined }
}
