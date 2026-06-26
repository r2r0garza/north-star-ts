import { listMessages } from "../../db/repositories/messages"
import { defaultTokenCounter, type TokenCounter } from "./token-counter"
import type { Message } from "../../db/types"

// An OpenAI-compatible chat message, the shape Portkey expects. The agent feeds
// the array this builder returns straight into the chat completion request.
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string | null
  tool_calls?: Array<{
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

// Default history budget in (approximate) tokens. Conservative relative to the
// model's real context window because the counter is a heuristic.
const DEFAULT_TOKEN_BUDGET = 12000

export interface ContextBuilderOptions {
  tokenCounter?: TokenCounter
  tokenBudget?: number
}

// Assembles the message array sent to the LLM for a turn. Today: system prompt
// + a token-budgeted walk-back over stored history (which already ends with the
// just-persisted user message). The rest of the app calls `build` and stays
// unaware of the strategy — later this composes summaries, memories, workspace
// state, task state, retrieved codebase context, etc. before the history walk.
export class ContextBuilder {
  private readonly counter: TokenCounter
  private readonly budget: number

  constructor(opts: ContextBuilderOptions = {}) {
    this.counter = opts.tokenCounter ?? defaultTokenCounter
    this.budget = opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET
  }

  build(conversationId: string, opts: { systemPrompt: string }): ChatMessage[] {
    const history = listMessages(conversationId)
    const included = this.walkBack(history, this.budget - this.counter.count(opts.systemPrompt))
    return [
      { role: "system", content: opts.systemPrompt },
      ...included.map(toChatMessage),
    ]
  }

  // Walk the stored history newest → oldest in *turn groups*, admitting whole
  // groups while the budget allows. Groups keep tool-call integrity intact: an
  // assistant message with tool_calls always travels with all of its tool
  // results, so the API never sees an orphaned tool message (which would 400).
  private walkBack(history: Message[], budget: number): Message[] {
    const groups = groupTurns(history)
    const chosen: Message[][] = []
    let remaining = budget
    for (let i = groups.length - 1; i >= 0; i--) {
      const group = groups[i]
      const cost = group.reduce((sum, m) => sum + this.cost(m), 0)
      if (cost > remaining) break
      remaining -= cost
      chosen.unshift(group)
    }
    return chosen.flat()
  }

  private cost(m: Message): number {
    if (m.tokenEstimate != null) return m.tokenEstimate
    let text = m.content ?? ""
    if (m.toolCalls?.length) text += JSON.stringify(m.toolCalls)
    return this.counter.count(text)
  }
}

// Group a chronological message list into turn groups. An assistant message
// bearing tool_calls starts a group that absorbs the following tool-result
// messages; every other message is its own single-element group.
function groupTurns(history: Message[]): Message[][] {
  const groups: Message[][] = []
  let i = 0
  while (i < history.length) {
    const m = history[i]
    if (m.role === "assistant" && m.toolCalls?.length) {
      const group = [m]
      i++
      while (i < history.length && history[i].role === "tool") {
        group.push(history[i])
        i++
      }
      groups.push(group)
    } else {
      groups.push([m])
      i++
    }
  }
  return groups
}

// Map a stored message to the OpenAI-compatible shape (inverse of how runChat
// persists turns).
function toChatMessage(m: Message): ChatMessage {
  if (m.role === "assistant" && m.toolCalls?.length) {
    return {
      role: "assistant",
      content: m.content,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.arguments },
      })),
    }
  }
  if (m.role === "tool") {
    return {
      role: "tool",
      content: m.content ?? "",
      tool_call_id: m.toolCallId ?? undefined,
    }
  }
  return { role: m.role, content: m.content }
}

// A shared default instance for the agent.
export const contextBuilder = new ContextBuilder()
