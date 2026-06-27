import type { Gate } from "../approval/types"

// --- ask_user_question ---
// The model asks the user one or more clarifying questions, each with preset
// options; the UI always appends a free-form "Other" choice. These types are
// the source of truth, re-exported through preload so the renderer shares them.
export interface QuestionOption {
  // The choice the user sees and selects. The model must make these distinct.
  label: string
  // Optional one-line explanation of what the choice means / its trade-off.
  description?: string
}
export interface Question {
  // The full question text shown to the user.
  question: string
  // A very short label (chip) for the question, e.g. "Auth method".
  header: string
  // When true the user may pick several options; otherwise exactly one.
  multiSelect?: boolean
  // 2-4 preset choices. The UI adds an "Other" free-form field on top.
  options: QuestionOption[]
}
// One question's answer: the chosen option labels, plus optional free-form text
// the user typed into "Other".
export interface QuestionAnswer {
  selected: string[]
  other?: string
}
// Outcome of an ask() round-trip: the user's answers, or a cancel (turn stopped
// before they answered).
export type AskResult =
  | { status: "answered"; answers: QuestionAnswer[] }
  | { status: "cancelled" }
// Injected into ToolContext so the ask_user_question tool can pause the turn and
// block on the human's answer (parallels `gate`). Absent in contexts that don't
// support it (e.g. unit tests) — the tool then reports it's unavailable.
export type Ask = (questions: Question[]) => Promise<AskResult>

// Runtime context passed to every tool. `workspace` is the absolute root the
// agent is confined to — tools must keep all file access inside it. In a Chat
// session there is no workspace; instead the user attaches specific files, and
// `attachments` is the absolute-path allowlist a file tool may read from.
export interface ToolContext {
  workspace: string
  attachments?: string[]
  // The conversation this turn belongs to — used to scope approval decisions.
  conversationId?: string
  // The single approval pipeline every gated tool routes through (see
  // ../approval). A tool builds a ToolAction and awaits `gate(action)` before
  // performing a side effect. Absent in contexts that don't gate (e.g. unit
  // tests) — gated tools then treat a required approval as denied (fail-closed).
  gate?: Gate
  // Pause the turn to ask the user clarifying questions (see ask_user_question).
  // Absent in contexts that can't prompt the user.
  ask?: Ask
}

// A tool the agent can call. `definition` is the OpenAI-compatible schema
// Portkey expects; `execute` runs server-side and returns a string result.
export interface Tool {
  definition: {
    type: "function"
    function: {
      name: string
      description: string
      parameters: Record<string, unknown>
    }
  }
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>
}
