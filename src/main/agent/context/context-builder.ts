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

// Fallback budget for optional system sections when no configured summarization
// threshold is supplied. Stored history is not truncated against this value.
const DEFAULT_TOKEN_BUDGET = 12000

// Fraction of the total budget that droppable context sections (skills, todos,
// index summary, task state, approvals) may consume before the rest are dropped.
// Caps sections so they can never starve the recent-message walk-back — the
// non-negotiable core alongside the base system prompt.
const DEFAULT_SECTION_BUDGET_SHARE = 0.5

// A labeled, droppable slice of non-conversational context (plan 014). `content`
// is already rendered by the caller (which owns the data sources); the builder
// only budgets and composes. Sections fold into the system block rather than
// faking user/assistant turns, keeping the transcript honest. Higher `priority`
// is admitted first and dropped last. An empty/blank `content` is skipped.
export interface ContextSection {
  name: string
  priority: number
  content: string
}

// Priorities for the built-in sections. Ascending = dropped first under budget
// pressure: the advisory index summary yields before the active todo plan, which
// yields before the agent's skills. Kept here so the drop order is one list, not
// scattered across call sites.
export const SECTION_PRIORITY = {
  environment: 5, // date/model/workspace/git orientation — small, most droppable
  browserState: 8, // live agent-browser page (url/title) — small live orientation
  index: 10, // advisory workspace orientation — most droppable
  approvals: 20,
  taskState: 30,
  todos: 40,
  skills: 50, // capability definitions
  summary: 60, // compressed older context — kept longest (dropping it loses the
  //             early thread a long conversation can't otherwise recover)
  planMode: 70, // plan-mode operating rules — never drop while plan mode is on
} as const

export interface ContextBuilderOptions {
  tokenCounter?: TokenCounter
  tokenBudget?: number
  sectionBudgetShare?: number
  // Sink for the include/drop report (defaults to console.debug). Injectable so
  // tests can assert what was dropped without scraping stdout.
  log?: (message: string) => void
}

// Assembles the message array sent to the LLM for a turn: a system block (the
// base prompt + budget-admitted context sections) followed by stored history
// (which already ends with the just-persisted user message). Before a summary
// exists the complete transcript is replayed; afterward the summary explicitly
// replaces messages through its coverage boundary and the complete tail follows.
// Sections are the extension point for summaries, memories, workspace/task state,
// etc. — each rendered by the caller, budgeted and composed here.
export class ContextBuilder {
  private readonly counter: TokenCounter
  private readonly budget: number
  private readonly sectionBudgetShare: number
  private readonly log: (message: string) => void

  constructor(opts: ContextBuilderOptions = {}) {
    this.counter = opts.tokenCounter ?? defaultTokenCounter
    this.budget = opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET
    this.sectionBudgetShare =
      opts.sectionBudgetShare ?? DEFAULT_SECTION_BUDGET_SHARE
    this.log = opts.log ?? ((m) => console.debug(m))
  }

  // `baseSystemPrompt` is the non-droppable core prompt (mode prompt). `sections`
  // are optional droppable context slices folded into the system block by
  // priority under a share of the budget.
  build(
    conversationId: string,
    opts: {
      baseSystemPrompt: string
      sections?: ContextSection[]
      historyAfterSeq?: number
      tokenBudget?: number
    }
  ): ChatMessage[] {
    const budget = opts.tokenBudget ?? this.budget
    const systemContent = this.composeSystemBlock(
      opts.baseSystemPrompt,
      opts.sections ?? [],
      budget
    )
    // A summary explicitly replaces messages through historyAfterSeq. Without a
    // summary, replay the entire stored transcript; never silently discard old
    // messages behind a second, unrelated context limit.
    const history = listMessages(conversationId).filter(
      (message) => message.seq > (opts.historyAfterSeq ?? 0)
    )
    return [
      { role: "system", content: systemContent },
      ...history.map(toChatMessage),
    ]
  }

  // Admit sections highest-priority-first while their cumulative cost fits the
  // section budget (a share of the total); drop the rest. Preserves each admitted
  // section's declared order in the final block for a stable, readable prompt.
  // Logs exactly what was included and dropped (no silent truncation).
  private composeSystemBlock(
    baseSystemPrompt: string,
    sections: ContextSection[],
    budget: number
  ): string {
    const present = sections.filter((s) => s.content.trim().length > 0)
    const sectionBudget = Math.floor(budget * this.sectionBudgetShare)
    const byPriority = [...present].sort((a, b) => b.priority - a.priority)

    const admitted = new Set<string>()
    const report: string[] = []
    let spent = 0
    for (const section of byPriority) {
      const cost = this.counter.count(section.content)
      if (spent + cost <= sectionBudget) {
        admitted.add(section.name)
        spent += cost
        report.push(`+${section.name}(${cost})`)
      } else {
        report.push(`-${section.name}(${cost}, over budget)`)
      }
    }
    if (present.length > 0) {
      this.log(
        `[context] sections: ${report.join(" ")} | used ${spent}/${sectionBudget} section-token budget`
      )
    }

    // Keep declaration order for the admitted sections (not priority order) so the
    // assembled prompt reads consistently turn to turn.
    const blocks = [baseSystemPrompt]
    for (const section of present) {
      if (admitted.has(section.name)) blocks.push(section.content)
    }
    return blocks.join("\n\n")
  }
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
