import * as kanban from "../db/repositories/kanban"
import {
  asActions,
  asDependencyLinks,
  asFilter,
  asOutcomes,
  asPromoteGate,
  resolveIntakeCall,
  WRITE_APPROVALS,
  type KanbanBoard,
  type KanbanColumn,
  type KanbanColumnInput,
  type KanbanSource,
  type KanbanWriteApproval,
} from "../../shared/kanban"
import { callProblem } from "./service"

// A board shared as a file: its recipe, filter, settings and columns. Never
// its workspace, cards, run history or approvals — the importer approves the
// intake recipe and tracker writes again on their machine.
export const BOARD_EXPORT_FORMAT = "north-star/kanban-board"
const VERSION = 1

export function exportBoard(board: KanbanBoard, columns: KanbanColumn[]) {
  const nameOf = (id?: string) => columns.find((c) => c.id === id)?.name ?? id
  return {
    format: BOARD_EXPORT_FORMAT,
    version: VERSION,
    name: board.name,
    source: board.source,
    filter: board.filter,
    syncIntervalMs: board.syncIntervalMs,
    writeApproval: board.writeApproval,
    worktrees: board.worktrees,
    parallelCommands: board.parallelCommands,
    notifications: board.notifications,
    autoPromote: board.autoPromote,
    dependencyLinks: board.dependencyLinks,
    // goto targets are ids on this machine; names survive the trip.
    columns: columns.map((c) => ({
      name: c.name,
      agentName: c.agentName,
      instructions: c.instructions,
      gate: c.gate,
      owner: c.owner,
      outcomes: c.outcomes.map((o) =>
        o.next === "goto" ? { ...o, target: nameOf(o.target) } : o
      ),
      actions: c.actions,
      command: c.command,
      commandTimeoutMs: c.commandTimeoutMs,
      notify: c.notify,
      wipLimit: c.wipLimit,
      entryGate: c.entryGate,
    })),
  }
}

// "Board", then "Board - Copy", then "Board - Copy 2", "Board - Copy 3"...
export function copyName(name: string, taken: string[]): string {
  const names = new Set(taken.map((n) => n.trim()))
  if (!names.has(name)) return name
  let candidate = `${name} - Copy`
  for (let n = 2; names.has(candidate); n++) candidate = `${name} - Copy ${n}`
  return candidate
}

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "")

// Validate an exported board and create it in `workspace`. Throws with a
// message for the user when the file isn't a board this app can use.
export function importBoard(raw: unknown, workspace: string): KanbanBoard {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >
  if (o.format !== BOARD_EXPORT_FORMAT)
    throw new Error("This file isn't an exported board.")
  if (typeof o.version !== "number" || o.version > VERSION)
    throw new Error("This board was exported by a newer version of the app.")
  const name = text(o.name)
  if (!name) throw new Error("The board has no name.")

  // Keep only recipe keys, as kanban_write does: anything else would be hashed.
  const {
    tracker,
    command,
    tool,
    args,
    itemsPath,
    fields,
    tagSeparator,
    whoami,
    note,
  } = (o.source && typeof o.source === "object" ? o.source : {}) as KanbanSource
  const source: KanbanSource = {
    tracker,
    command,
    tool,
    args,
    itemsPath,
    fields,
    tagSeparator,
    whoami,
    note,
  }
  if (!source.fields?.id || !source.fields?.title)
    throw new Error(
      "The board's intake recipe is missing its id and title fields."
    )
  const filter = asFilter(o.filter)
  let problem: string | null
  try {
    problem = callProblem(resolveIntakeCall(source, filter), workspace)
  } catch (err) {
    problem = (err as Error).message
  }
  if (problem) throw new Error(`Intake recipe: ${problem}`)

  const columns: KanbanColumnInput[] = (
    Array.isArray(o.columns) ? o.columns : []
  ).map((c) => {
    const r = (c && typeof c === "object" ? c : {}) as Record<string, unknown>
    const user = r.owner === "user"
    return {
      name: text(r.name),
      agentName: text(r.agentName) || null,
      instructions: text(r.instructions),
      gate: r.gate === "human" ? "human" : "agent",
      owner: user ? "user" : "agent",
      outcomes: asOutcomes(r.outcomes),
      actions: asActions(r.actions),
      command: user ? text(r.command) || null : null,
      commandTimeoutMs:
        typeof r.commandTimeoutMs === "number" ? r.commandTimeoutMs : null,
      notify: r.notify === true,
      wipLimit: typeof r.wipLimit === "number" ? r.wipLimit : null,
      entryGate: asPromoteGate(r.entryGate),
    }
  })
  if (columns.some((c) => !c.name))
    throw new Error("Every column needs a name.")
  for (const c of columns)
    for (const a of c.actions ?? []) {
      const bad = callProblem(a, workspace)
      if (bad) throw new Error(`Column "${c.name}", action "${a.name}": ${bad}`)
    }

  const writeApproval = WRITE_APPROVALS.includes(
    o.writeApproval as KanbanWriteApproval
  )
    ? (o.writeApproval as KanbanWriteApproval)
    : "once_per_action"
  let board: KanbanBoard
  try {
    board = kanban.saveBoard({
      name: copyName(
        name,
        kanban.listBoards().map((b) => b.name)
      ),
      workspace,
      source,
      filter,
      syncIntervalMs:
        typeof o.syncIntervalMs === "number" ? o.syncIntervalMs : undefined,
      columns,
    })
  } catch (err) {
    if (err instanceof kanban.KanbanColumnInUseError)
      throw new Error(err.message)
    throw err
  }
  kanban.setActionSettings(board.id, { writeApproval, actionsPaused: false })
  kanban.setRunSettings(board.id, {
    worktrees: o.worktrees !== false,
    parallelCommands: o.parallelCommands === true,
  })
  kanban.setNotifications(board.id, o.notifications !== false)
  kanban.setAutoPromote(board.id, asPromoteGate(o.autoPromote))
  kanban.setDependencyLinks(board.id, asDependencyLinks(o.dependencyLinks))
  return kanban.getBoard(board.id)!
}
