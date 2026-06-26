// Runtime context passed to every tool. `workspace` is the absolute root the
// agent is confined to — tools must keep all file access inside it. In a Chat
// session there is no workspace; instead the user attaches specific files, and
// `attachments` is the absolute-path allowlist a file tool may read from.
export interface ToolContext {
  workspace: string
  attachments?: string[]
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
