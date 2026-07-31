import { listMessages } from "../db/repositories/messages"
import { listTasks } from "../db/repositories/tasks"
import { getConversation } from "../db/repositories/conversations"
import {
  getConversationSummary,
  upsertConversationSummary,
} from "../db/repositories/conversation-summaries"
import {
  resolveLlm,
  createCompletion,
  isTransientError,
  NoActiveProviderError,
  type LlmSelection,
} from "../agent/providers"
import { defaultTokenCounter } from "../agent/context/token-counter"
import type { TaskRunner, TaskExecutor } from "../tasks/runner"
import type { Message } from "../db/types"

// The rolling conversation summary generator (plan 019). A compact, periodically
// regenerated digest of the turns scrolling out of the ContextBuilder's
// recent-message window, so a long conversation keeps its early thread. It runs
// OUT OF BAND as a deterministic 009 task kind (`summarize`) — it makes exactly
// ONE bounded, non-streaming LLM call (no agentic loop), so the user's turn
// latency is never affected. One SummaryService per app, holding the runner
// reference so the post-turn trigger can enqueue.

// The task kind driven by this service's executor.
export const SUMMARIZE_KIND = "summarize"

// Smallest transcript worth summarizing. A short chat fits the walk-back whole —
// summarizing it wastes an LLM call and buys nothing.
const MIN_MESSAGES = 10

// Debounce: only (re)summarize once the tail past `coversThrough` has grown by at
// least this many turns OR this many estimated tokens. Keeps regeneration
// incremental and cheap — we don't re-summarize every turn, only when enough new
// context has accumulated to be worth folding in.
const TRIGGER_TURNS = 20
const TRIGGER_TOKENS = 6000

// Cap on the digest's own size (output tokens). The prompt also asks the model to
// stay terse; this is the hard ceiling.
const MAX_SUMMARY_TOKENS = 1024

// Per-message cap when rendering the transcript for the summarizer, so one giant
// tool result can't blow the single-shot input budget. The digest is lossy by
// design — a truncated tool dump is fine to summarize from.
const MAX_MESSAGE_CHARS = 2000

// Task statuses that mean a summarize run is already in flight for a conversation
// — the trigger won't enqueue a duplicate. Mirrors IndexService.LIVE_STATUSES.
const LIVE_STATUSES = new Set([
  "queued",
  "running",
  "waiting_for_approval",
  "paused",
  "interrupted",
])

// What the summarize task carries in its input blob (per the 015 producer
// contract — config rides in the blob, not new columns). `conversationId` here is
// the SOURCE conversation being summarized, NOT the task's forked worker
// transcript (which the executor never reads or writes).
interface SummarizeInput {
  conversationId?: string
}

export class SummaryService {
  constructor(private readonly runner: TaskRunner) {}

  // The executor the runner invokes for the `summarize` kind. Registered at app
  // init: runner.registerKind(SUMMARIZE_KIND, { autoResume: false, run }). No
  // forked-conversation LLM turn — it reads the SOURCE transcript from the input
  // blob, folds the prior digest + new turns into one LLM call, and upserts.
  readonly execute: TaskExecutor = async ({ task, signal }) => {
    const input = task.input as SummarizeInput | null
    const conversationId = input?.conversationId
    if (!conversationId)
      return { error: "summarize task missing conversationId" }

    const messages = listMessages(conversationId)
    if (messages.length === 0) return { content: "nothing to summarize" }

    const prior = getConversationSummary(conversationId)
    const coversThrough = prior?.coversThrough ?? 0
    // Fold only the turns not yet in the digest (incremental regeneration).
    const fresh = messages.filter((m) => m.seq > coversThrough)
    if (fresh.length === 0) return { content: "summary already current" }

    // The new high-water mark and count reflect the ENTIRE transcript folded so
    // far (prior coverage + this batch), since the digest subsumes the old one.
    const newCoversThrough = messages[messages.length - 1].seq
    const newMessageCount = messages.length

    // Resolve the SOURCE conversation's own model (falls back to the default).
    const conversation = getConversation(conversationId)
    const selection: LlmSelection = {
      accountId: conversation?.accountId ?? null,
      modelId: conversation?.modelId ?? null,
    }

    try {
      const { client, model, apiMode } = resolveLlm(selection)
      const res = await createCompletion(
        client,
        model,
        MAX_SUMMARY_TOKENS,
        {
          messages: [
            { role: "system", content: SUMMARY_SYSTEM_PROMPT },
            {
              role: "user",
              content: buildSummaryUserPrompt(prior?.summary, fresh),
            },
          ],
        },
        // Pass the abort signal so a cancel/pause unwinds the in-flight call.
        [undefined, { signal }],
        apiMode
      )
      const choice = (
        res as {
          choices?: {
            message?: { content?: unknown }
            finish_reason?: string
          }[]
        }
      ).choices?.[0]
      // The model hit the output cap before finishing. Storing the partial digest
      // would persist a truncated summary (cut off mid-section) into every future
      // system prompt, so treat it as a retryable failure instead — the next
      // attempt re-runs with the same bounded input. (Mirrors the main agent
      // loop's finish_reason==="length" handling.)
      if (choice?.finish_reason === "length")
        return { error: "summary truncated (hit output cap)", retryable: true }

      const summary = stripPreamble(contentToText(choice?.message?.content))
      if (!summary) return { error: "empty summary", retryable: false }

      upsertConversationSummary({
        conversationId,
        summary,
        coversThrough: newCoversThrough,
        messageCount: newMessageCount,
        tokenEstimate: defaultTokenCounter.count(summary),
      })
      return { content: `summarized ${newMessageCount} messages` }
    } catch (err) {
      if (signal.aborted) return { stopped: true }
      // No provider configured / model gone: a stale summary is harmless, so fail
      // fast without retry — the next turn re-triggers once config is fixed.
      if (err instanceof NoActiveProviderError)
        return { error: err.message, retryable: false }
      const message = err instanceof Error ? err.message : String(err)
      return { error: message, retryable: isTransientError(err) }
    }
  }

  // Post-turn trigger: after a turn completes, enqueue a summarize task IF the
  // conversation is long enough and enough new context has accumulated past the
  // current digest. Cheap and synchronous (a threshold check + at most one
  // enqueue) — the actual LLM call runs out of band in the task runner, so this
  // never adds to the turn's latency. Idempotent: no-op if a summarize run for
  // this conversation is already in flight.
  maybeSummarize(conversationId: string): void {
    const messages = listMessages(conversationId)
    if (messages.length < MIN_MESSAGES) return

    const prior = getConversationSummary(conversationId)
    const coversThrough = prior?.coversThrough ?? 0
    const fresh = messages.filter((m) => m.seq > coversThrough)
    if (fresh.length === 0) return

    const freshTokens = fresh.reduce((sum, m) => sum + costOf(m), 0)
    if (fresh.length < TRIGGER_TURNS && freshTokens < TRIGGER_TOKENS) return

    if (this.hasLiveTask(conversationId)) return

    this.runner.enqueueKind({
      kind: SUMMARIZE_KIND,
      title: "Summarizing conversation",
      input: { conversationId },
    })
  }

  // Whether a summarize task for this SOURCE conversation is already queued or
  // running. Scans by kind + the source id carried in the input blob (there's no
  // indexed column for it — the tasks table is small, so a filtered scan is fine).
  private hasLiveTask(conversationId: string): boolean {
    return listTasks().some((t) => {
      const input = t.input as (SummarizeInput & { kind?: string }) | null
      return (
        input?.kind === SUMMARIZE_KIND &&
        input?.conversationId === conversationId &&
        LIVE_STATUSES.has(t.status)
      )
    })
  }
}

// A message's estimated token cost (cached on the row, else counted). Mirrors
// ContextBuilder.cost so the trigger's threshold aligns with the builder's budget.
function costOf(m: Message): number {
  if (m.tokenEstimate != null) return m.tokenEstimate
  let text = m.content ?? ""
  if (m.toolCalls?.length) text += JSON.stringify(m.toolCalls)
  return defaultTokenCounter.count(text)
}

// Normalize an LLM content value (string or array of parts) to plain text.
function contentToText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string" ? part : ((part as { text?: string })?.text ?? "")
      )
      .join("")
  }
  return ""
}

// Drop any conversational preamble the model emits before the structured digest.
// Despite the "only summarize, don't answer" instruction, some models lead with a
// chatty line (e.g. "Sure, go for it — what are you testing?") before the first
// `##` section; that stray text would then ride verbatim into every future system
// prompt. Keep from the first heading on. If the model produced no heading at all
// (off-format), keep the trimmed raw text — a malformed digest beats an empty one.
function stripPreamble(text: string): string {
  const idx = text.indexOf("##")
  return (idx > 0 ? text.slice(idx) : text).trim()
}

const SUMMARY_SYSTEM_PROMPT =
  "You maintain a rolling summary of a long assistant/user conversation so its " +
  "early context survives after old turns scroll out of the model's window. " +
  "You are given the PRIOR summary (if any) and the NEW turns since it was last " +
  "updated. Produce a single UPDATED summary that folds the new turns into the " +
  "prior one — carry forward everything still relevant, drop what's been " +
  "superseded, and stay terse (well under 400 words).\n\n" +
  "Summarize the CONVERSATION: the user's goals and intent, decisions reached, " +
  "constraints and preferences stated, questions raised, and what was tried or " +
  "concluded. Do NOT record volatile workspace/repository facts that come from " +
  "tooling — the current git branch, file/symbol counts, package metadata, file " +
  "paths, directory listings, importer lists, or symbol locations. Those are " +
  "provided fresh from the live index elsewhere in the prompt, so copying them " +
  "here only risks going stale and contradicting the current values. Capture a " +
  "technical fact only when it's a durable conclusion of the conversation itself " +
  "(e.g. 'we decided to store X in table Y'), not a raw readout of the repo's " +
  "current state.\n\n" +
  "This overrides 'carry forward': if the PRIOR summary contains such volatile " +
  "repo-state facts (file counts, importer lists, directory listings, tsconfig / " +
  "build details, branch names, symbol line numbers), actively DELETE them from " +
  "the updated summary — do NOT carry them forward. The live index already " +
  "supplies them.\n\n" +
  "Do NOT answer or continue the conversation; only summarize it. Begin your " +
  "reply directly with the first heading — no preamble. Use exactly these four " +
  "sections, each a short bulleted list (write 'None yet.' if empty):\n" +
  "## Decisions — choices made and settled (what and why).\n" +
  "## Constraints — requirements, preferences, and rules to keep honoring.\n" +
  "## Open threads — unresolved questions and in-progress work.\n" +
  "## Key facts — durable context established IN the conversation (not repo state)."

function buildSummaryUserPrompt(
  priorSummary: string | undefined,
  fresh: Message[]
): string {
  // Both inputs are fenced as DATA, not left as an open-ended chat log. A bare
  // `user:/assistant:` transcript ending in an `UPDATED SUMMARY:` cue reads like
  // a completion to continue — the model would auto-extend the transcript
  // (re-typing turns, even inventing new ones) before summarizing, burning the
  // output budget and truncating the real digest. Delimited blocks + a trailing
  // imperative (not a cue) make it a summarize-this-data task instead.
  const priorBlock = priorSummary
    ? `<prior_summary>\n${priorSummary}\n</prior_summary>`
    : "<prior_summary>\n(none — this is the first summary)\n</prior_summary>"
  const transcript = fresh.map(renderMessage).join("\n")
  return (
    `${priorBlock}\n\n` +
    `<new_turns>\n${transcript}\n</new_turns>\n\n` +
    "Update the rolling summary by folding <new_turns> into <prior_summary>, " +
    "following the rules above. Output ONLY the four `##` sections. Do NOT repeat, " +
    "quote, or continue the transcript, and do NOT add any turns of your own."
  )
}

// Render one stored message compactly for the summarizer. Tool calls and results
// are labeled so the model can see what the agent did, truncated so one big blob
// can't dominate the single-shot input.
function renderMessage(m: Message): string {
  const clip = (s: string): string =>
    s.length > MAX_MESSAGE_CHARS ? s.slice(0, MAX_MESSAGE_CHARS) + "…" : s
  if (m.role === "assistant" && m.toolCalls?.length) {
    const calls = m.toolCalls.map((c) => c.name).join(", ")
    const text = m.content ? `${clip(m.content)} ` : ""
    return `assistant: ${text}[called tools: ${calls}]`
  }
  if (m.role === "tool") {
    return `tool(${m.toolName ?? "result"}): ${clip(m.content ?? "")}`
  }
  return `${m.role}: ${clip(m.content ?? "")}`
}
