import type { Gate } from "../approval/types"
import type { Environment } from "../env/types"
import type { TodoStatus } from "../../db/types"

// Hand work off to the durable task runner from inside a tool. A thin shape over
// TaskRunner.enqueue (the producer-contract seam, plan 015) — passed via
// ToolContext rather than imported, so the agent layer never depends on the
// runner (which imports the agent layer). `seedTodos` lets run_todos_in_background
// snapshot the conversation's list into the forked worker conversation.
export type EnqueueTaskInput = {
  conversationId: string
  message: string
  kind?: string
  title?: string | null
  seedTodos?: Array<{ itemId: string; content: string; status: TodoStatus }>
}
export type EnqueueTask = (input: EnqueueTaskInput) => {
  id: string
  status: string
}

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
  // The execution/filesystem backend this turn's tools run against (see ../env).
  // Optional for backward-compat: when absent, tools fall back to a
  // LocalEnvironment(workspace), so a bare ToolContext (e.g. in unit tests) keeps
  // working with host fs/spawn exactly as before. The real agent loop always sets it.
  env?: Environment
  // The turn's abort signal, threaded into env.exec. When the user presses Stop
  // (or the command times out), the local backend SIGKILLs the running command's
  // whole process group, so a slow in-flight shell command stops promptly instead
  // of delaying the turn's end (see .plan/005).
  signal?: AbortSignal
  // Hand the remaining work off to a durable background task (see EnqueueTask).
  // Set by the real agent loop; absent in contexts that can't delegate (e.g.
  // unit tests) — run_todos_in_background then reports it's unavailable.
  enqueueTask?: EnqueueTask
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
