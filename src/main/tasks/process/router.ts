import {
  resolveLlm,
  createCompletion,
  NoActiveProviderError,
  type LlmSelection,
} from "../../agent/providers"
import { loadAgent } from "../../agent/agents/loader"
import type { ProcessPhaseAgent } from "../../db/types"

// Dispatch routing for a Process phase (plan 025.3). A `routing:'dispatch'` phase
// binds a POOL of agents; this module picks the best-fit one per (sub-)task via a
// single bounded, non-streaming LLM classification over the agents' `description`
// metadata (the same signal spawn_subagent's parent LLM uses to pick a child).
// There is no programmatic scorer — the model decides. Rule-based routing
// (skills/glob/path match) stays deferred.

// The classifier's reply is just an agent name, so a tiny output budget suffices.
const MAX_ROUTE_TOKENS = 64

// Per-agent description cap when rendering the pool, so one runaway description
// can't dominate the (small) classification prompt. Mirrors the loader's own
// MAX_DESCRIPTION ceiling; this is a belt-and-suspenders clip for the prompt.
const MAX_DESCRIPTION_CHARS = 500

// The (sub-)task prompt is only a routing SIGNAL — the model needs its gist, not
// the whole briefing. Clip it so a large kickoff can't blow the input budget.
const MAX_TASK_CHARS = 4000

export interface RouteInput {
  // The phase's agent pool, in authored order. pool[0] is the deterministic
  // fallback (matches the `single` path), so this must be non-empty.
  pool: ProcessPhaseAgent[]
  // The (sub-)task briefing to route — a fan-out child's sub-task prompt, or a
  // plain dispatch phase's kickoff. Used as the classification signal.
  taskPrompt: string
  // The run conversation's model selection, inherited so the classifier is cheap
  // and consistent with the run (Open Q #8 / #2 — inherit, not a fixed model).
  selection: LlmSelection
  // Workspace root for loadAgent (agent files layer user → workspace).
  workspace?: string
  signal: AbortSignal
}

// Pick the best-fit agent from the pool for the given (sub-)task. Always returns a
// pool member's `agentName`: on an empty/malformed reply, a parse miss, no
// configured provider, or any classifier error, it falls back to pool[0] so a
// `dispatch` phase never wedges.
export async function route(input: RouteInput): Promise<string> {
  const { pool, taskPrompt, selection, workspace, signal } = input
  const fallback = pool[0]?.agentName ?? null
  if (!fallback) throw new Error("route() called with an empty agent pool")
  // Nothing to classify with a single-agent pool — skip the LLM call entirely.
  if (pool.length === 1) return fallback

  // Resolve each pool agent's description (the routing signal). A pool agent that
  // no longer loads keeps its slot with an empty description rather than dropping
  // out — it stays selectable and the positions/fallback are unchanged.
  const defs = await Promise.all(
    pool.map((a) => loadAgent(a.agentName, workspace).catch(() => null))
  )
  const candidates = pool.map((a, i) => ({
    name: a.agentName,
    description: defs[i]?.description ?? "",
  }))

  try {
    const { client, model, apiMode } = resolveLlm(selection)
    const res = await createCompletion(
      client,
      model,
      MAX_ROUTE_TOKENS,
      {
        messages: [
          { role: "system", content: ROUTER_SYSTEM_PROMPT },
          {
            role: "user",
            content: buildRouteUserPrompt(candidates, taskPrompt),
          },
        ],
      },
      // Pass the abort signal so a run cancel/pause unwinds the in-flight call.
      [undefined, { signal }],
      apiMode
    )
    const choice = (
      res as { choices?: { message?: { content?: unknown } }[] }
    ).choices?.[0]
    const reply = contentToText(choice?.message?.content)
    return matchAgent(reply, pool) ?? fallback
  } catch (err) {
    // No provider configured, or any classifier failure: fall back deterministically
    // rather than wedging the phase (the `single` path would've used pool[0] anyway).
    if (err instanceof NoActiveProviderError) return fallback
    if (signal.aborted) return fallback
    return fallback
  }
}

// Match the classifier's free-text reply to a pool agent name. Prefers an exact
// (trimmed, case-insensitive) match; else the first pool agent whose name appears
// as a token in the reply — tolerant of a model that answers "Agent: backend" or
// wraps the name in punctuation. Returns null if nothing in the pool matches.
function matchAgent(reply: string, pool: ProcessPhaseAgent[]): string | null {
  const text = reply.trim().toLowerCase()
  if (!text) return null
  for (const a of pool) {
    if (a.agentName.toLowerCase() === text) return a.agentName
  }
  // Longest names first so a name that's a substring of another can't shadow it.
  const byLength = [...pool].sort(
    (a, b) => b.agentName.length - a.agentName.length
  )
  for (const a of byLength) {
    const re = new RegExp(`\\b${escapeRegExp(a.agentName.toLowerCase())}\\b`)
    if (re.test(text)) return a.agentName
  }
  return null
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Normalize an LLM content value (string or array of parts) to plain text.
function contentToText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : ((part as { text?: string })?.text ?? "")
      )
      .join("")
  }
  return ""
}

const ROUTER_SYSTEM_PROMPT =
  "You are a router that assigns one task to the single best-fit agent from a " +
  "fixed roster. Each agent has a name and a description of what it specializes " +
  "in. Read the task, then reply with EXACTLY the name of the one agent best " +
  "suited to it — nothing else. No punctuation, no explanation, no quotes. If " +
  "several could do it, pick the closest specialty match."

function buildRouteUserPrompt(
  candidates: { name: string; description: string }[],
  taskPrompt: string
): string {
  const roster = candidates
    .map((c) => {
      const desc = c.description.trim().slice(0, MAX_DESCRIPTION_CHARS)
      return `- ${c.name}: ${desc || "(no description)"}`
    })
    .join("\n")
  const task =
    taskPrompt.length > MAX_TASK_CHARS
      ? taskPrompt.slice(0, MAX_TASK_CHARS) + "…"
      : taskPrompt
  return (
    "## Agents\n" +
    `${roster}\n\n` +
    "## Task\n" +
    `${task.trim() || "(no task provided)"}\n\n` +
    "Reply with the name of the single best-fit agent from the list above, and " +
    "nothing else."
  )
}
