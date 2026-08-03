import type { Gate } from "../approval/types"
import type { Environment } from "../env/types"
import type { TodoStatus } from "../../db/types"
import type { BrowserHandle } from "../../browser/manager"

// A JPEG image a tool produced (currently browser_screenshot) that should be
// shown to the vision-capable model. Tool results themselves are text-only (they
// are persisted/replayed as strings), so a tool hands an image to the loop via
// `emitImage`; the loop injects it as a follow-up user message with an image
// content part before the next model round-trip. `alt` is a short caption used
// as the text part alongside the image.
export interface ToolImage {
  jpegBase64: string
  alt: string
}
// Side-channel a tool uses to attach an image to the current turn. Absent in
// contexts that can't render images (e.g. unit tests) — a tool then just returns
// its text result.
export type EmitImage = (image: ToolImage) => void

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
  // Optional Markdown body rendered above the options, in a fixed-height
  // scrollable box, so a question can carry context the user must read before
  // answering. Used by present_plan to show the plan alongside its approval
  // prompt. Not model-facing: ask_user_question never sets it (it builds
  // Question from model args explicitly), so it stays out of that tool's schema.
  body?: string
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
  // The agent-controllable browser for this turn, bound to ctx.signal (see
  // BrowserManager.handleForTurn). Absent when no browser is available (e.g.
  // unit tests) — browser tools then report the browser is unavailable.
  browser?: BrowserHandle
  // Attach an image to the current turn for the vision model (see ToolImage /
  // EmitImage). Used by browser_screenshot; absent where images can't be shown.
  emitImage?: EmitImage
  // Flip plan mode on/off for the CURRENT turn (see present_plan_tool). Set by the
  // real agent loop, which holds plan mode as a mutable flag and rebuilds the
  // toolset each iteration — so approving a plan (setPlanMode(false)) unlocks the
  // filesystem tools for the same turn. Absent where plan mode isn't in play.
  setPlanMode?: (on: boolean) => void
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
