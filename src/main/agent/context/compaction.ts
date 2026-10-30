import type { Message, Provider, Todo } from "../../db/types"
import { MESSAGE_OVERHEAD_TOKENS, messageTokens } from "./request-size"

// In-turn context compaction (plan 118). Both tiers rewrite only the in-memory
// request; the persisted transcript is never touched.

// Tier 1 rewrites earlier tool results client-side. Anthropic binds thinking
// signatures to the prefix and Google's acceptance is unverified, so they only
// get tier 2 (a fresh rebuild). Claude subscription and CLI agents get neither.
const TIER1_PROVIDERS = new Set<Provider>([
  "portkey",
  "openai",
  "openai_compatible",
  "azure_openai",
  "codex_subscription",
])
const TIER2_PROVIDERS = new Set<Provider>([
  ...TIER1_PROVIDERS,
  "anthropic",
  "google",
])

export function compactionTiers(provider: Provider | null | undefined): {
  clear: boolean
  // Tier 1 runs on the provider (Anthropic context editing); the loop only
  // sends the thresholds and judges tier 2 by the reported input size.
  serverClear: boolean
  rebuild: boolean
} {
  return {
    clear: !!provider && TIER1_PROVIDERS.has(provider),
    serverClear: provider === "anthropic",
    rebuild: !!provider && TIER2_PROVIDERS.has(provider),
  }
}

// The effective high watermark: the setting, lowered to a safe share of the
// model's real input window when the adapter knows it. 0 disables compaction.
export function compactionWatermarks(
  setting: number,
  contextWindow: number | null
): { high: number; low: number } | null {
  if (setting <= 0) return null
  const high = contextWindow
    ? Math.min(setting, Math.floor(contextWindow * 0.8))
    : setting
  return { high, low: Math.floor(high / 2) }
}

// Results that carry instructions or current state rather than evidence.
const PROTECTED_TOOLS = new Set(["read_skill", "present_plan"])
// Verification tools whose latest result per target feeds the work ledger.
const VERIFICATION_TOOLS = new Set([
  "run_tests",
  "get_test_results",
  "workspace_diagnostics",
])
// Rounds (client-side) or tool uses (server-side) always kept verbatim.
export const KEEP_RECENT_TOOL_USES = 3
// Server-side clearing can't keep only the latest result per target, so it
// keeps every verification result.
export const COMPACTION_PROTECTED_TOOLS: readonly string[] = [
  ...PROTECTED_TOOLS,
  ...VERIFICATION_TOOLS,
]
const STUB_PREFIX = "[Earlier result cleared to save context:"

function parseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function verificationKey(name: string, args: Record<string, unknown>): string {
  return `${name}:${String(args.target ?? args.session_id ?? "")}`
}

// Tier 1: replace older tool results with stubs, oldest first, until the
// request is at or under `target` tokens. `total` is the request's current
// measured size. Returns a new array; untouched messages keep their identity.
export function clearOldToolResults(
  messages: readonly any[],
  opts: { total: number; target: number; keepRecentRounds?: number }
): { messages: any[]; cleared: number; total: number } {
  const keepRecent = opts.keepRecentRounds ?? KEEP_RECENT_TOOL_USES
  const calls = new Map<
    string,
    { name: string; args: Record<string, unknown> }
  >()
  const latestVerification = new Map<string, string>()
  const assistantIndexes: number[] = []
  messages.forEach((message, index) => {
    if (message?.role !== "assistant") return
    if (Array.isArray(message.tool_calls)) {
      assistantIndexes.push(index)
      for (const call of message.tool_calls) {
        const name = String(call?.function?.name ?? "")
        const args = parseArgs(call?.function?.arguments)
        calls.set(call.id, { name, args })
        if (VERIFICATION_TOOLS.has(name))
          latestVerification.set(verificationKey(name, args), call.id)
      }
    }
  })
  const protectedFrom =
    assistantIndexes.length > keepRecent
      ? assistantIndexes[assistantIndexes.length - keepRecent]
      : 0

  const out = [...messages]
  let total = opts.total
  let cleared = 0
  const clearedIds = new Set<string>()
  for (let i = 0; i < protectedFrom && total > opts.target; i++) {
    const message = out[i]
    if (message?.role !== "tool") continue
    const call = calls.get(message.tool_call_id)
    if (!call || PROTECTED_TOOLS.has(call.name)) continue
    if (
      VERIFICATION_TOOLS.has(call.name) &&
      latestVerification.get(verificationKey(call.name, call.args)) ===
        message.tool_call_id
    )
      continue
    if (
      typeof message.content === "string" &&
      message.content.startsWith(STUB_PREFIX)
    )
      continue
    const before = messageTokens(message)
    const hint = call.args.path ?? call.args.target ?? call.args.command
    const stub = {
      ...message,
      content: `${STUB_PREFIX} ${call.name}${typeof hint === "string" ? ` ${hint.slice(0, 120)}` : ""}, ~${(before / 1000).toFixed(1)}k tokens. Re-run the tool if you need it.]`,
    }
    out[i] = stub
    total -= before - messageTokens(stub)
    cleared += 1
    clearedIds.add(message.tool_call_id)
  }
  // Drop replayed tool images whose results were cleared. Each replay message's
  // text parts name their source as `<tool>:<toolCallId>`.
  // shortcut: one replay message holds a whole round's images, so a round only
  // partly cleared loses all of them; split per call if that ever matters.
  for (let i = protectedFrom - 1; i >= 0 && clearedIds.size; i--) {
    const message = out[i]
    if (message?.role !== "user" || !Array.isArray(message.content)) continue
    const text = message.content
      .map((part: any) => (part?.type === "text" ? part.text : ""))
      .join("")
    const ids = [...clearedIds].filter((id) => text.includes(`:${id}`))
    if (
      ids.length === 0 ||
      !message.content.some((p: any) => p?.type === "image_url")
    )
      continue
    const before = messageTokens(message)
    out.splice(i, 1)
    total -= before + MESSAGE_OVERHEAD_TOKENS
  }
  return { messages: out, cleared, total }
}

// What a compaction must never lose: the turn's instructions, verbatim.
// `turnMessages` are the stored messages after the turn's start seq; `opening`
// is the request that started the turn when it was persisted before it (a
// resumed or workflow turn).
export function pinnedInstructions(
  turnMessages: readonly Message[],
  opening: readonly Message[]
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of [...opening, ...turnMessages]) {
    if (m.role !== "user" || !m.content || seen.has(m.id)) continue
    seen.add(m.id)
    out.push(m.content)
  }
  return out
}

const LEDGER_EXCERPT_CHARS = 1500

// The work ledger: built from the turn's stored tool records, not the summary.
export function buildWorkLedger(
  turnMessages: readonly Message[],
  todos: readonly Todo[]
): string {
  const results = new Map(
    turnMessages
      .filter((m) => m.role === "tool" && m.toolCallId)
      .map((m) => [m.toolCallId!, m.content ?? ""])
  )
  const files = new Map<string, string>()
  const verification = new Map<string, string>()
  for (const m of turnMessages) {
    for (const call of m.toolCalls ?? []) {
      const args = parseArgs(call.arguments)
      const result = results.get(call.id)
      const outcome =
        result === undefined
          ? "no result"
          : result.startsWith("ERROR[") || result.startsWith("Error running ")
            ? "failed"
            : "ok"
      const touch = (path: unknown, action: string) => {
        if (typeof path === "string" && path)
          files.set(path, `${action} (${outcome})`)
      }
      switch (call.name) {
        case "write_file_tool":
          touch(args.path, "written")
          break
        case "edit_file_tool":
          touch(args.path, "edited")
          break
        case "create_directory":
          touch(args.path, "created")
          break
        case "delete_path":
          touch(args.path, "deleted")
          break
        case "move_path":
          touch(args.from, `moved to ${String(args.to ?? "?")}`)
          break
        case "apply_patch_tool":
          for (const op of Array.isArray(args.operations)
            ? args.operations
            : [])
            touch(
              op?.path,
              op?.type === "move"
                ? `moved to ${op?.new_path}`
                : `patched (${op?.type})`
            )
          break
      }
      if (VERIFICATION_TOOLS.has(call.name) && result !== undefined) {
        const excerpt =
          result.length > LEDGER_EXCERPT_CHARS
            ? `${result.slice(0, LEDGER_EXCERPT_CHARS)}…`
            : result
        verification.set(
          verificationKey(call.name, args),
          `${call.name} ${JSON.stringify(args)}:\n${excerpt}`
        )
      }
    }
  }
  const open = todos.filter(
    (t) => t.status === "pending" || t.status === "in_progress"
  )
  const list = (items: string[]) =>
    items.length ? items.map((item) => `- ${item}`).join("\n") : "- None."
  return [
    "## Work ledger (from tool records)",
    "### Files modified this turn",
    list([...files].map(([path, state]) => `${path}: ${state}`)),
    "### Latest verification results",
    list([...verification.values()]),
    "### Open todo items",
    list(open.map((t) => `[${t.status}] ${t.content}`)),
  ].join("\n")
}

// The latest round's tool call and its results. The model has not seen these
// results yet, so a tier 2 rebuild must carry them past the summary; folding
// them away makes the agent re-run the same tools forever.
export function latestRound(messages: readonly any[]): any[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== "assistant") continue
    if (!Array.isArray(message.tool_calls) || !message.tool_calls.length)
      return []
    return [
      message,
      ...messages.slice(i + 1).filter((m) => m?.role === "tool"),
    ]
  }
  return []
}

// Shorten a round's results proportionally so they fit `budget` tokens, with
// a note telling the agent how to get the rest.
export function clipToolResults(round: readonly any[], budget: number): any[] {
  const tokens = round
    .filter((m) => m?.role === "tool")
    .reduce((sum, m) => sum + messageTokens(m), 0)
  if (tokens <= budget) return [...round]
  // Character counts only approximate tokens; leave headroom.
  const share = (Math.max(0, budget) / tokens) * 0.9
  return round.map((m) => {
    if (m?.role !== "tool" || typeof m.content !== "string") return m
    const keep = Math.floor(m.content.length * share)
    return {
      ...m,
      content: `${m.content.slice(0, keep)}\n[Truncated to fit the context budget: showing ${keep} of ${m.content.length} characters. Read the rest in smaller ranges if you need it.]`,
    }
  })
}

// The single in-memory user message a tier 2 rebuild ends with.
export function continuationMessage(
  instructions: readonly string[],
  ledger: string
): { role: "user"; content: string } {
  return {
    role: "user",
    content: [
      "## Instructions for this turn (verbatim)",
      ...instructions,
      ledger,
      "Earlier work in this turn is summarized above. The ledger is authoritative where the summary disagrees. Continue from Remaining.",
    ].join("\n\n"),
  }
}
