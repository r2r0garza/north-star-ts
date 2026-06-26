import type { Gate } from "../approval/types"

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
