import { createHash } from "crypto"
import * as kanban from "../db/repositories/kanban"
import { listTasks } from "../db/repositories/tasks"
import type { TaskRunner, TaskExecutor } from "../tasks/runner"
import type { Task } from "../db/types"
import { stripAnsi } from "../agent/approval/ansi"
import { shellActionForCommand } from "../agent/approval/shell-analyzer"
import { makePolicyEngine } from "../agent/approval/engine"
import { createEnvironment } from "../agent/env/factory"
import { getMcpManager, parsePrefixedName } from "../agent/mcp"
import { validateCommandResult } from "../dashboards/service"
import * as settingsService from "../settings/service"
import {
  matchesFilter,
  normalizeItems,
  parseJsonOutput,
  pickAll,
  resolveIntakeCall,
  type KanbanBoard,
  type KanbanBoardGraph,
  type KanbanCall,
} from "../../shared/kanban"

export const KANBAN_SYNC_KIND = "kanban_sync"

const LIVE_STATUSES = new Set(["queued", "running", "waiting_for_approval"])
const EXEC_TIMEOUT_MS = 60_000
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

// Runs one recipe call and returns its raw text output, or throws.
export type RunCall = (
  call: KanbanCall,
  board: KanbanBoard,
  signal: AbortSignal
) => Promise<string>

// The call a sync runs, with the filter's query bound in, or why it can't run.
export function intakeCall(
  board: Pick<KanbanBoard, "source" | "filter">
): { call: KanbanCall } | { error: string } {
  if (!board.source) return { error: "board has no intake recipe" }
  try {
    return { call: resolveIntakeCall(board.source, board.filter) }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

// The approval covers the recipe AND the call it resolves to, so editing the
// recipe or a filter that changes the query re-asks.
export function approvalHash(
  board: Pick<KanbanBoard, "source" | "filter">
): string | null {
  const resolved = intakeCall(board)
  if (!("call" in resolved)) return null
  return createHash("sha256")
    .update(JSON.stringify({ source: board.source, run: resolved.call }))
    .digest("hex")
}

// Why this call can't run at all, or null. Checked at authoring and before replay.
export function callProblem(
  call: KanbanCall,
  workspace: string | null
): string | null {
  if (!!call.command === !!call.tool)
    return "a call needs exactly one of `command` or `tool`"
  if (call.command && !workspace)
    return "a command recipe needs a workspace to run in"
  if (call.tool && !parsePrefixedName(call.tool))
    return "`tool` must be an MCP tool name like mcp__<server>__<tool>"
  return null
}

const policy = makePolicyEngine()

const defaultRunCall: RunCall = async (call, board, signal) => {
  if (call.tool) {
    const text = await getMcpManager().callTool(
      call.tool,
      call.args ?? {},
      board.workspace ?? undefined,
      signal
    )
    if (text.startsWith("ERROR[mcp]")) throw new Error(text)
    return text
  }
  const command = call.command!
  const workspace = board.workspace!
  // The board approval is the user's explicit grant for this recipe; a
  // hard-blocked command still never runs.
  const decision = policy.decide(
    shellActionForCommand(command, {
      tool: "run_shell_tool",
      cwd: workspace,
      workspace,
    }),
    { workspacePath: workspace }
  )
  if (decision.level === "hard_block")
    throw new Error("recipe command is blocked and cannot run")
  const env = await createEnvironment(
    workspace,
    `kanban:${board.id}`,
    settingsService.getExecutionConfig()
  )
  try {
    const result = await env.exec(command, {
      cwd: workspace,
      timeoutMs: EXEC_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      signal,
    })
    const problem = validateCommandResult(result)
    if (problem) throw new Error(problem)
    return stripAnsi(result.stdout.toString("utf8"))
  } finally {
    await env.dispose()
  }
}

// Board intake (plan 136.1): replays the board's approved recipe with no LLM,
// normalizes the items, re-checks each against the structured filter locally,
// and updates the Inbox. Fails closed: unapproved, unresolvable "me", or bad
// output records an error and leaves the cards untouched.
export class KanbanService {
  constructor(
    private readonly runner: TaskRunner,
    private readonly runCall: RunCall = defaultRunCall
  ) {}

  readonly execute: TaskExecutor = async ({ task, signal }) => {
    const boardId = (task.input as { boardId?: string } | null)?.boardId
    const board = boardId ? kanban.getBoard(boardId) : null
    if (!board) return { error: "board not found" }
    try {
      const count = await this.sync(board, signal)
      kanban.setSyncResult(board.id, null)
      return { content: `synced ${count} items` }
    } catch (err) {
      if (signal.aborted) return { stopped: true }
      const message = err instanceof Error ? err.message : String(err)
      kanban.setSyncResult(board.id, message)
      return { error: message, retryable: false }
    }
  }

  private async sync(board: KanbanBoard, signal: AbortSignal): Promise<number> {
    const source = board.source
    const resolved = intakeCall(board)
    if (!source || !("call" in resolved))
      throw new Error(
        "error" in resolved ? resolved.error : "board has no intake recipe"
      )
    if (board.approvedHash !== approvalHash(board))
      throw new Error("needs approval — approve the intake recipe on the board")
    const problem = callProblem(resolved.call, board.workspace)
    if (problem) throw new Error(problem)

    let me: string | null = null
    if (board.filter.assignee.mode === "me") {
      if (!source.whoami)
        throw new Error('assignee "me" needs a whoami recipe to resolve')
      const whoProblem = callProblem(source.whoami, board.workspace)
      if (whoProblem) throw new Error(`whoami: ${whoProblem}`)
      const raw = await this.runCall(source.whoami, board, signal)
      // A bare identity string is fine; otherwise read JSON at `path`.
      let value: unknown = raw.trim()
      try {
        value = JSON.parse(raw)
      } catch {
        // not JSON: use the trimmed text
      }
      const leaf = source.whoami.path
        ? pickAll(value, source.whoami.path)[0]
        : value
      me = typeof leaf === "string" && leaf.trim() ? leaf.trim() : null
      if (!me) throw new Error('could not resolve "me" from the whoami recipe')
    }

    const output = parseJsonOutput(
      await this.runCall(resolved.call, board, signal)
    )
    const items = normalizeItems(output, source).filter((item) =>
      matchesFilter(item, board.filter, me)
    )
    kanban.applySync(board.id, items)
    return items.length
  }

  ensureSync(boardId: string): Task | null {
    if (!kanban.getBoard(boardId)) return null
    const live = listTasks().some((t) => {
      const input = t.input as { kind?: string; boardId?: string } | null
      return (
        input?.kind === KANBAN_SYNC_KIND &&
        input.boardId === boardId &&
        LIVE_STATUSES.has(t.status)
      )
    })
    if (live) return null
    return this.runner.enqueueKind({
      kind: KANBAN_SYNC_KIND,
      title: "Syncing board",
      input: { boardId },
    })
  }

  graph(boardId: string): KanbanBoardGraph | null {
    const board = kanban.getBoard(boardId)
    if (!board) return null
    const hash = approvalHash(board)
    const resolved = intakeCall(board)
    return {
      board,
      columns: kanban.listColumns(boardId),
      cards: kanban.listCards(boardId),
      sourceHash: hash,
      intakeCall: "call" in resolved ? resolved.call : null,
      intakeError: "error" in resolved ? resolved.error : null,
      approved: !!hash && board.approvedHash === hash,
    }
  }

  // Approve the recipe the user was shown (by hash), so a recipe rewritten
  // between display and click is never approved blind. Then sync.
  approveSource(
    boardId: string,
    hash: string
  ): { ok: true; taskId: string | null } | { ok: false; reason: string } {
    const board = kanban.getBoard(boardId)
    if (!board) return { ok: false, reason: "board not found" }
    if (approvalHash(board) !== hash)
      return { ok: false, reason: "the recipe changed — review it again" }
    kanban.setApprovedHash(boardId, hash)
    const task = this.ensureSync(boardId)
    return { ok: true, taskId: task ? task.id : null }
  }
}
