import { TOOL_EFFECTS, type Tool } from "./types"
import { toolError } from "./output"
import * as kanban from "../../db/repositories/kanban"
import {
  asFilter,
  compileIntakeQuery,
  normalizeItems,
  parseJsonOutput,
  resolveIntakeCall,
  type KanbanCall,
  type KanbanSource,
} from "../../../shared/kanban"
import { callProblem } from "../../kanban/service"

// Author a kanban board fed by an external tracker (plan 136.1). The agent
// probes the real CLI/MCP output first, then saves the intake recipe here. The
// recipe never runs until the user approves it on the board, so this tool only
// writes its own tables and is not gated (same as dashboard_write).
export const kanbanWriteTool: Tool = {
  effects: TOOL_EFFECTS.mutation,
  definition: {
    type: "function",
    function: {
      name: "kanban_write",
      description:
        "Save a kanban board that pulls work items from an external tracker (Azure DevOps, " +
        "Jira, GitHub Issues, ...) through a CLI or MCP server the user already has. " +
        "FIRST run the real query yourself (run_shell or the MCP tool) and look at the JSON " +
        "it returns; then call this with the same call as `source`.\n\n" +
        "source: { tracker, command? | tool?+args?, itemsPath?, fields, tagSeparator?, whoami? }\n" +
        "- tracker: 'github' | 'jira' | 'ado'. The board compiles `filter` into that " +
        "tracker's query (GitHub search, JQL, or a full WIQL SELECT) on every sync and " +
        "substitutes it for the literal placeholder {{query}} in `command` (shell-quoted as one " +
        "argument — do NOT add quotes around it) or in string `args`. Always use {{query}} so " +
        "the filter drives what is fetched.\n" +
        "- command: shell command run in the workspace that prints JSON, e.g. " +
        "`gh issue list --search {{query}} --json number,title,url,body,labels,assignees,state,updatedAt --limit 200`, " +
        "`az boards query --wiql {{query}} -o json`. OR tool: an MCP tool name " +
        '`mcp__<server>__<tool>` with `args` (e.g. { "jql": "{{query}}" }). Never both.\n' +
        "- The result of this call shows `query` and `resolvedCall`; run resolvedCall yourself to " +
        "check it before telling the user. Every item is also re-checked locally against `filter`.\n" +
        "- itemsPath: path to the item array in the output (omit if the output is the array).\n" +
        "- fields: paths inside one item for id, title (required), url, body, type, state, " +
        "tags, assignee, updatedAt. A path is a dotted string, or an array of keys when a key " +
        'contains dots (ADO: ["fields","System.Tags"]). "*" maps over an array ' +
        '(GitHub: tags "labels.*.name", assignee "assignees.*.login").\n' +
        '- tagSeparator: split a single tags string (ADO uses ";").\n' +
        "- whoami: required when filter.assignee is me. A call (command or tool+args) " +
        "returning the signed-in user's identity as the tracker reports it in the assignee " +
        'field, plus `path` into its JSON. GitHub: { command: "gh api user", path: "login" }. ' +
        'ADO: { command: "az ad signed-in-user show -o json", path: "userPrincipalName" }. ' +
        "Jira MCP: the server's current-user tool, path to accountId.\n\n" +
        "filter: { tags: [...], match: 'any'|'all', excludeTags: [...], assignee: " +
        "{ mode: 'me' } | { mode: 'anyone' } | { mode: 'user', user }, query? }. Use assignee me (with whoami) unless the user " +
        "explicitly asks for items regardless of assignee: 'anyone' pulls teammates' and " +
        "unassigned items onto this machine. " +
        "`query` is an escape hatch: a raw GitHub search / JQL / WIQL used instead of the compiled " +
        "one (only when the user asks for something the structured fields can't express); the " +
        "structured fields are still re-checked locally, so keep them consistent with it.\n" +
        "columns: ordered column names (items land in an Inbox before the first column).\n" +
        "sample: optionally paste the raw JSON you got; the result shows how it normalizes.\n\n" +
        "Pass boardId to update an existing board. The user must approve the intake recipe " +
        "on the board before it syncs; a changed recipe needs approval again.",
      parameters: {
        type: "object",
        properties: {
          boardId: { type: "string", description: "Board to update." },
          name: { type: "string", description: "Board name." },
          source: { type: "object", description: "The intake recipe." },
          filter: { type: "object", description: "Structured intake filter." },
          columns: {
            type: "array",
            items: { type: "string" },
            description: "Ordered column names.",
          },
          syncIntervalMinutes: {
            type: "number",
            description:
              "How often to sync while the board is open (default 5).",
          },
          sample: {
            type: "string",
            description:
              "Raw JSON output from your probe, to preview normalization.",
          },
        },
        required: ["name", "source"],
      },
    },
  },
  execute: async (args, ctx) => {
    const a = args as Record<string, unknown>
    const parsed = (v: unknown) => {
      if (typeof v !== "string") return v
      try {
        return JSON.parse(v) as unknown
      } catch {
        return v
      }
    }
    const name = typeof a.name === "string" ? a.name.trim() : ""
    if (!name) return toolError("bad_args", "`name` is required.")
    const boardId = typeof a.boardId === "string" ? a.boardId : undefined
    if (boardId && !kanban.getBoard(boardId))
      return toolError("not_found", `No board with id ${boardId}.`)

    const raw = parsed(a.source) as KanbanSource | null
    if (!raw || typeof raw !== "object")
      return toolError("bad_args", "`source` must be an object.")
    // Keep only recipe keys: anything else would be stored and hashed.
    const {
      tracker,
      command,
      tool,
      args: toolArgs,
      itemsPath,
      fields,
      tagSeparator,
      whoami,
      note,
    } = raw
    const source: KanbanSource = {
      tracker,
      command,
      tool,
      args: toolArgs,
      itemsPath,
      fields,
      tagSeparator,
      whoami,
      note,
    }
    if (!source.fields || !source.fields.id || !source.fields.title)
      return toolError(
        "bad_args",
        "`source.fields` needs at least id and title."
      )
    const workspace = ctx.workspace?.trim() || null
    const filter = asFilter(parsed(a.filter))
    let resolvedCall: KanbanCall
    try {
      resolvedCall = resolveIntakeCall(source, filter)
    } catch (err) {
      return toolError("bad_args", `source: ${(err as Error).message}`)
    }
    const problem = callProblem(resolvedCall, workspace)
    if (problem) return toolError("bad_args", `source: ${problem}`)
    if (filter.assignee.mode === "me") {
      if (!source.whoami)
        return toolError(
          "bad_args",
          'filter.assignee is "me": add source.whoami so the board can resolve the signed-in user (GitHub: { "command": "gh api user", "path": "login" }). Use assignee "anyone" only if the user asked for items regardless of assignee.'
        )
      const whoProblem = callProblem(source.whoami, workspace)
      if (whoProblem) return toolError("bad_args", `whoami: ${whoProblem}`)
    }
    const columns = (
      Array.isArray(parsed(a.columns)) ? (parsed(a.columns) as unknown[]) : []
    )
      .filter((c): c is string => typeof c === "string" && !!c.trim())
      .map((c) => c.trim())
    const minutes =
      typeof a.syncIntervalMinutes === "number"
        ? a.syncIntervalMinutes
        : undefined

    let preview: unknown = undefined
    if (typeof a.sample === "string" && a.sample.trim()) {
      try {
        const items = normalizeItems(parseJsonOutput(a.sample), source)
        preview = { itemCount: items.length, firstItems: items.slice(0, 3) }
      } catch (err) {
        preview = { error: err instanceof Error ? err.message : String(err) }
      }
    }

    const board = kanban.saveBoard({
      id: boardId,
      name,
      workspace,
      source,
      filter,
      columns,
      syncIntervalMs: minutes ? minutes * 60_000 : undefined,
    })
    return JSON.stringify({
      boardId: board.id,
      name: board.name,
      columns,
      filter,
      query:
        source.tracker || filter.query
          ? compileIntakeQuery(filter, source.tracker ?? "github")
          : undefined,
      resolvedCall,
      preview,
      next: "Ask the user to open Boards and approve the intake recipe; it syncs after approval.",
    })
  },
}
