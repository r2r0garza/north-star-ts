import { TOOL_EFFECTS, type Tool } from "./types"
import { toolError } from "./output"
import * as kanban from "../../db/repositories/kanban"
import {
  asActions,
  asFilter,
  asOutcomes,
  compileIntakeQuery,
  mergeAgentColumns,
  normalizeItems,
  parseJsonOutput,
  resolveIntakeCall,
  type KanbanCall,
  type KanbanColumnInput,
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
        "{ mode: 'me' } | { mode: 'anyone' } | { mode: 'user', user }, types?: [...], states?: [...], query? }. " +
        "types/states (empty = any) need source.fields.type / fields.state mapped, or nothing matches. Use assignee me (with whoami) unless the user " +
        "explicitly asks for items regardless of assignee: 'anyone' pulls teammates' and " +
        "unassigned items onto this machine. " +
        "`query` is an escape hatch: a raw GitHub search / JQL / WIQL used instead of the compiled " +
        "one (only when the user asks for something the structured fields can't express); the " +
        "structured fields are still re-checked locally, so keep them consistent with it.\n" +
        "columns: ordered columns (items land in an Inbox before the first). Each is a name, or " +
        "{ name, instructions?, agent?, gate? }. instructions: what an agent does to a card in this " +
        "column; {{id}}, {{url}} and {{branch}} in them are replaced with the card's values (e.g. " +
        "'write the plan to plan-{{id}}.md'), and no other {{...}} is allowed. Empty instructions = " +
        "no agent run; the card just sits there, e.g. a final Done column. agent: " +
        "a named agent (omit for the built-in North Star agent). gate: 'agent' (default; the card " +
        "moves on when the agent reports done) or 'human' (the card waits for the user to approve). " +
        "outcomes (optional): the column's possible verdicts on the item, e.g. QA " +
        "[{ name: 'passed', next: 'advance' }, { name: 'failed', next: 'goto', target: 'Development', maxReturns: 2 }, " +
        "{ name: 'incomplete', next: 'wait' }]. The agent reports one in its handoff. next: 'advance' " +
        "(next column), 'wait' (a person decides), 'end' (the card finishes here), or 'goto' (rerun the " +
        "`target` column, by name, with this column's findings; after maxReturns automatic returns, " +
        "default 2, the card waits for a person). Only judging columns (review, QA) need outcomes.\n" +
        "actions (optional): tracker writes, run without an LLM: { name, phase: 'enter'|'exit', " +
        "when?: [outcome names] (exit only; omit for any), command | tool+args }. Placeholders " +
        "{{id}} {{url}} {{branch}} {{result}} (the column's handoff text, exit only) are bound per card, " +
        "shell-quoted in a command (do NOT add quotes), e.g. `gh issue edit {{id}} --add-label in-review`, " +
        "`gh issue comment {{id}} --body {{result}}`. Probe the CLI/MCP call yourself first on a test item. " +
        "Every write is audited and goes through the board's write-approval level, which only the user sets. " +
        "Omit outcomes/actions on an existing column to keep them.\n" +
        "Columns are matched to existing ones by name, so renaming creates a new column; a removed " +
        "column must be empty. Omit `columns` when updating to leave them unchanged.\n" +
        "The result may list columns marked `readOnly: true`: the user's own columns. Leave them out " +
        "of `columns`; they keep their place and can't be renamed, changed, or removed by you. " +
        "A goto `target` may name one.\n" +
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
            items: {},
            description:
              "Ordered columns: names or { name, instructions?, agent?, gate?, outcomes?, actions? }.",
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
    // The local re-check needs the field, or every item fails it.
    for (const [key, field] of [
      ["types", "type"],
      ["states", "state"],
    ] as const)
      if (filter[key].length && !source.fields[field])
        return toolError(
          "bad_args",
          `filter.${key} needs source.fields.${field} mapped, or no item matches.`
        )
    if (filter.assignee.mode === "me") {
      if (!source.whoami)
        return toolError(
          "bad_args",
          'filter.assignee is "me": add source.whoami so the board can resolve the signed-in user (GitHub: { "command": "gh api user", "path": "login" }). Use assignee "anyone" only if the user asked for items regardless of assignee.'
        )
      const whoProblem = callProblem(source.whoami, workspace)
      if (whoProblem) return toolError("bad_args", `whoami: ${whoProblem}`)
    }
    const rawColumns = parsed(a.columns)
    const columns: KanbanColumnInput[] | undefined = Array.isArray(rawColumns)
      ? rawColumns
          .map((c): KanbanColumnInput | null => {
            if (typeof c === "string")
              return c.trim() ? { name: c.trim() } : null
            if (!c || typeof c !== "object") return null
            const o = c as Record<string, unknown>
            const text = (v: unknown) => (typeof v === "string" ? v.trim() : "")
            return text(o.name)
              ? {
                  name: text(o.name),
                  instructions: text(o.instructions),
                  agentName: text(o.agent) || null,
                  gate: o.gate === "human" ? "human" : "agent",
                  ...(o.outcomes !== undefined
                    ? { outcomes: asOutcomes(parsed(o.outcomes)) }
                    : {}),
                  ...(o.actions !== undefined
                    ? { actions: asActions(parsed(o.actions)) }
                    : {}),
                }
              : null
          })
          .filter((c): c is KanbanColumnInput => c !== null)
      : boardId
        ? undefined
        : []
    for (const column of columns ?? [])
      for (const action of column.actions ?? []) {
        const actionProblem = callProblem(action, workspace)
        if (actionProblem)
          return toolError(
            "bad_args",
            `column "${column.name}", action "${action.name}": ${actionProblem}`
          )
      }
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

    // The agent writes only agent columns; the user's keep their place.
    let merged: KanbanColumnInput[] | undefined
    try {
      merged =
        columns &&
        mergeAgentColumns(boardId ? kanban.listColumns(boardId) : [], columns)
    } catch (err) {
      return toolError("bad_columns", (err as Error).message)
    }
    let board
    try {
      board = kanban.saveBoard({
        id: boardId,
        name,
        workspace,
        source,
        filter,
        columns: merged,
        syncIntervalMs: minutes ? minutes * 60_000 : undefined,
      })
    } catch (err) {
      if (err instanceof kanban.KanbanColumnInUseError)
        return toolError("bad_columns", err.message)
      throw err
    }
    return JSON.stringify({
      boardId: board.id,
      name: board.name,
      columns: kanban.listColumns(board.id).map((c) =>
        c.owner === "user"
          ? { name: c.name, readOnly: true }
          : {
              name: c.name,
              instructions: c.instructions,
              agent: c.agentName,
              gate: c.gate,
              outcomes: c.outcomes,
              actions: c.actions,
            }
      ),
      filter,
      query:
        source.tracker || filter.query
          ? compileIntakeQuery(filter, source.tracker ?? "github")
          : undefined,
      resolvedCall,
      preview,
      writeApproval: board.writeApproval,
      next: "Ask the user to open Boards and approve the intake recipe; it syncs after approval. Tracker writes from actions ask for approval on the card per the board's write-approval level (Settings).",
    })
  },
}
