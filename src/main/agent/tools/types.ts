import type { Gate } from "../approval/types"
import type {
  CommandCompletionInbox,
  CommandCompletionOwner,
} from "../command-completion-inbox"
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

// Spawn a custom agent as a subagent and BLOCK for its final answer. Unlike
// EnqueueTask (fire-and-forget durable task), this runs a nested agent loop
// inline and resolves with the child's result, so the parent can use the answer.
// Passed via ToolContext (not imported) for the same cycle-avoidance as
// EnqueueTask: the concrete implementation lives in the agent module and calls
// runAgentLoop. Absent where spawning isn't wired (e.g. unit tests) — the
// spawn_subagent tool then reports it's unavailable.
export type SpawnSubagent = (input: {
  agentName: string
  prompt: string
}) => Promise<{ content?: string; error?: string; stopped?: boolean }>

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
  // Custom label for the free-form "Other" choice. Defaults to "Other…" when
  // absent. Used by present_plan to show "Refine Plan…" instead.
  otherLabel?: string
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

// Runtime context passed to every tool. `workspace` is the absolute root file
// tools are confined to. Local shell commands run on the host with this as cwd;
// they are not OS-sandboxed by cwd alone. In a Chat session there is no
// workspace; instead the user attaches specific files, and `attachments` is the
// absolute-path allowlist a file tool may read from.
export interface ToolContext {
  workspace: string
  attachments?: string[]
  // The conversation this turn belongs to — used to scope approval decisions.
  conversationId?: string
  // Stable durable identity for the currently executing tool call. Unlike the
  // provider's transient tool-call id, this is derived before execution from the
  // conversation plus normalized operation and survives regenerated call ids.
  invocationId?: string
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
  // Read-only auxiliary roots registered by read_skill during this turn. Keys
  // are skill names; values are absolute host paths to the selected skill folder.
  skillResourceRoots?: Record<string, string>
  // Flip plan mode on/off for the CURRENT turn (see present_plan_tool). Set by the
  // real agent loop, which holds plan mode as a mutable flag and rebuilds the
  // toolset each iteration — so approving a plan (setPlanMode(false)) unlocks the
  // filesystem tools for the same turn. Absent where plan mode isn't in play.
  setPlanMode?: (on: boolean) => void
  // Activate auto mode for the CURRENT turn (see present_plan_tool). When on,
  // all require_approval gate decisions are automatically approved so the agent
  // implements without any confirmation prompts. Set by present_plan when the
  // user picks "Yes, approve and work in Auto mode". Absent where auto mode
  // isn't in play.
  setAutoMode?: (on: boolean) => void
  // --- Subagent spawning (custom-agent fleet) ---
  // Spawn a permitted child agent and block for its answer (see spawn_subagent).
  // Set by the agent loop only when the running agent may spawn; absent otherwise.
  spawnSubagent?: SpawnSubagent
  // Which agents the RUNNING agent may spawn (its resolved `children` tri-state):
  //   undefined → may not spawn any (spawn_subagent isn't offered)
  //   []        → may spawn any loadable agent
  //   [names]   → may spawn only these
  // The spawn tool re-checks this as the authorization gate (no approval prompt).
  agentChildren?: string[]
  // Subagent-tree depth of THIS run (0 at the top level). The spawn tool rejects
  // a spawn once this reaches MAX_AGENT_DEPTH.
  agentDepth?: number
  // Names of the agents from the tree root down to (not including) this run's own
  // agent. The spawn tool rejects spawning any name already in this chain (cycle
  // guard); the spawn helper appends the child's name when recursing.
  agentAncestors?: string[]
  // Run-scoped background command completion inbox. `exec_command` registers
  // background sessions here, and the agent loop drains/waits on this same owner
  // before later model requests or finalization.
  commandCompletions?: CommandCompletionInbox
  commandCompletionOwner?: CommandCompletionOwner
  // --- Process phase context (plan 031.2 cross-phase flag-back) ---
  // Set ONLY when this turn is a Process phase worker (makeRunPhase forks the
  // conversation with these). The flag_for_rework tool uses them to load the run's
  // graph, validate the flagged target is a real upstream phase, and record a
  // durable flag. Absent for ordinary chats/subagents — flag_for_rework then
  // reports it's unavailable (and isn't offered).
  processRunId?: string
  processPhaseRunId?: string
}

export interface ToolEffects {
  readOnly: boolean
  parallelSafe: boolean
  idempotent: boolean
  destructive: boolean
  openWorld: boolean
}

export const TOOL_EFFECTS = {
  readOnlyParallel: {
    readOnly: true,
    parallelSafe: true,
    idempotent: true,
    destructive: false,
    openWorld: false,
  },
  readOnlySequential: {
    readOnly: true,
    parallelSafe: false,
    idempotent: true,
    destructive: false,
    openWorld: false,
  },
  openWorldRead: {
    readOnly: true,
    parallelSafe: false,
    idempotent: true,
    destructive: false,
    openWorld: true,
  },
  mutation: {
    readOnly: false,
    parallelSafe: false,
    idempotent: false,
    destructive: false,
    openWorld: false,
  },
  destructiveMutation: {
    readOnly: false,
    parallelSafe: false,
    idempotent: false,
    destructive: true,
    openWorld: false,
  },
  openWorldMutation: {
    readOnly: false,
    parallelSafe: false,
    idempotent: false,
    destructive: false,
    openWorld: true,
  },
} as const satisfies Record<string, ToolEffects>

// A tool the agent can call. `definition` is the OpenAI-compatible schema
// Portkey expects; `effects` declares scheduling/approval-relevant side effects;
// `execute` runs server-side and returns a string result.
export interface ToolExecutionPolicy {
  // Execution budget measured from dispatch. Bounded filesystem/database reads
  // use 30s; process-backed searches/git allow 35s around their 30s backend
  // deadline; extraction/navigation allow 120s for parsing/index startup.
  // Omit for human waits and resumable commands whose backend owns deadlines.
  // Expiry aborts ctx.signal; unsupported cleanup remains an unknown mutation.
  timeoutMs?: number
}

export interface Tool {
  executionPolicy?: ToolExecutionPolicy
  effects: ToolEffects
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
