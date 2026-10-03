import { app } from "electron"
import { appendFile, mkdir, rename, rm, stat } from "fs/promises"
import path from "path"
import type { RequestSize } from "./request-size"

// Per-round context usage log (plan 108): one JSON line per model round, so we
// can see whether long agent runs approach their context window and how much
// of each request is old tool output. Counts, IDs, and tool names only — never
// message content. Always on; rotated at 10 MB with one old file kept.

export const CONTEXT_USAGE_LOG_FILE = "context-usage.jsonl"
export const CONTEXT_USAGE_LOG_ROTATED_FILE = "context-usage.1.jsonl"
export const CONTEXT_USAGE_LOG_MAX_BYTES = 10 * 1024 * 1024

export type ContextUsageOutcome =
  | "ok"
  | "retry"
  | "stalled"
  | "truncated"
  | "error"
  | "aborted"

export interface ContextUsageEntry {
  at: string
  conversationId: string
  taskId: string | null
  agentDepth: number
  turnStartSeq: number
  // 1-based model round within the turn; `attempt` is the transport attempt
  // within that round's current logical id (a re-issue after a stall or a
  // raised output cap starts a new id, see `roundId`).
  round: number
  roundId: string
  attempt: number
  provider: string | null
  accountId: string
  model: string
  mode: string
  seat: {
    address: string
    profile: string
    featureId: string
    anchor: { kind: string; id: string } | null
  } | null
  request: {
    reported: number | null
    estimated: number
    estimator: string
    // reported / estimated, when the provider sent usage.
    ratio: number | null
    // Whether stream_options.include_usage was sent for this account.
    usageRequested: boolean
    byRole: RequestSize["byRole"]
    toolDefs: number
    messageCount: number
    largest: RequestSize["largestMessage"]
  }
  response: {
    reported: number | null
    estimated: number | null
    finishReason: string | null
  }
  outcome: ContextUsageOutcome
}

export interface ContextUsageLog {
  // Best-effort and serialized: resolves once this entry is written (or
  // dropped). Never rejects.
  append(entry: ContextUsageEntry): Promise<void>
}

function kilo(tokens: number): string {
  return `${(tokens / 1000).toFixed(1)}k`
}

// `[ctx] round 17 · 48.2k in (reported) · 0.8k out` — one console line per
// round while running `pnpm dev`.
export function formatContextUsageLine(entry: ContextUsageEntry): string {
  const inbound =
    entry.request.reported !== null
      ? `${kilo(entry.request.reported)} in (reported)`
      : `${kilo(entry.request.estimated)} in (est)`
  const outTokens = entry.response.reported ?? entry.response.estimated
  const outbound = outTokens !== null ? ` · ${kilo(outTokens)} out` : ""
  const outcome = entry.outcome === "ok" ? "" : ` · ${entry.outcome}`
  return `[ctx] round ${entry.round} · ${inbound}${outbound}${outcome}`
}

export function createContextUsageLog(options: {
  dir: () => string
  maxBytes?: number
  console?: Pick<Console, "info" | "warn">
}): ContextUsageLog {
  const maxBytes = options.maxBytes ?? CONTEXT_USAGE_LOG_MAX_BYTES
  const out = options.console ?? console
  let queue: Promise<void> = Promise.resolve()
  let warned = false

  async function write(entry: ContextUsageEntry): Promise<void> {
    const line = `${JSON.stringify(entry)}\n`
    const dir = options.dir()
    const file = path.join(dir, CONTEXT_USAGE_LOG_FILE)
    await mkdir(dir, { recursive: true })
    const size = await stat(file).then(
      (info) => info.size,
      () => 0
    )
    if (size > 0 && size + Buffer.byteLength(line) > maxBytes) {
      const rotated = path.join(dir, CONTEXT_USAGE_LOG_ROTATED_FILE)
      // Windows rename won't replace an existing file.
      await rm(rotated, { force: true })
      await rename(file, rotated)
    }
    await appendFile(file, line, "utf-8")
  }

  return {
    append(entry) {
      try {
        out.info(formatContextUsageLine(entry))
      } catch {
        // Console output is a convenience only.
      }
      queue = queue.then(
        () =>
          write(entry).catch((error) => {
            if (warned) return
            warned = true
            out.warn("[ctx] could not write context usage log:", error)
          }),
        () => {}
      )
      return queue
    },
  }
}

export const contextUsageLog = createContextUsageLog({
  dir: () => path.join(app.getPath("userData"), "logs"),
})
