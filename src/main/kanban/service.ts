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
import { detectedLinks, workspaceLayout } from "./layout"
import {
  matchesFilter,
  normalizeItems,
  parseJsonOutput,
  pickAll,
  resolveIntakeCall,
  type KanbanAction,
  type KanbanBoard,
  type KanbanBoardGraph,
  type KanbanCall,
  type KanbanCard,
  type KanbanColumn,
  type KanbanItem,
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

const sha = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex")

// An action recipe's identity for approval: a changed recipe is a new action.
export const actionHash = (action: KanbanAction) => sha(action)

// once_per_board: one approval covers every action on the board as it is now.
export const boardActionsHash = (columns: KanbanColumn[]) =>
  sha(columns.map((c) => [c.id, c.actions]))

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

// Board commands skip the approval prompt (the user granted them), but a
// command the policy hard-blocks never runs.
function isHardBlocked(command: string, workspace: string): boolean {
  return (
    policy.decide(
      shellActionForCommand(command, {
        tool: "run_shell_tool",
        cwd: workspace,
        workspace,
      }),
      { workspacePath: workspace }
    ).level === "hard_block"
  )
}

export interface CommandRunResult {
  exitCode: number | null
  timedOut: boolean
  output: string
}

// The tail of a user-column command's output kept on its run.
const COMMAND_OUTPUT_TAIL_CHARS = 4_000

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
  if (isHardBlocked(command, workspace))
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
  // Set by the app once card runs exist: auto-promote after each sync.
  afterSync?: (boardId: string) => Promise<void>

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
      await this.afterSync?.(board.id)
      return { content: `synced ${count} items` }
    } catch (err) {
      if (signal.aborted) return { stopped: true }
      const message = err instanceof Error ? err.message : String(err)
      kanban.setSyncResult(board.id, message)
      return { error: message, retryable: false }
    }
  }

  private async sync(board: KanbanBoard, signal: AbortSignal): Promise<number> {
    const items = await this.fetchMatching(board, signal)
    kanban.applySync(board.id, items)
    return items.length
  }

  // The board's items upstream that still pass its filter, or throws.
  private async fetchMatching(
    board: KanbanBoard,
    signal: AbortSignal
  ): Promise<KanbanItem[]> {
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
    return normalizeItems(output, source).filter((item) =>
      matchesFilter(item, board.filter, me)
    )
  }

  // The "New board" form's Test: the same fetch a sync does, before saving.
  testDraft(
    draft: Pick<KanbanBoard, "workspace" | "source" | "filter">,
    signal: AbortSignal
  ): Promise<KanbanItem[]> {
    const board = { ...draft, id: "draft" } as KanbanBoard
    board.approvedHash = approvalHash(board)
    return this.fetchMatching(board, signal)
  }

  // Before an upstream action: re-fetch and re-check the item (still tagged,
  // still assigned to the filter's person). Throws when that can't be checked.
  async stillMatches(board: KanbanBoard, card: KanbanCard): Promise<boolean> {
    const items = await this.fetchMatching(board, AbortSignal.timeout(120_000))
    return items.some((i) => i.id === card.externalId)
  }

  // Run one bound upstream action call; returns its output or throws.
  runAction(call: KanbanCall, board: KanbanBoard): Promise<string> {
    const problem = callProblem(call, board.workspace)
    if (problem) return Promise.reject(new Error(problem))
    return this.runCall(call, board, AbortSignal.timeout(120_000))
  }

  // A user column's own command (136.5), run for one card in `cwd` through the
  // user's execution settings. No approval prompt; hard-blocked commands throw.
  // timeoutMs null = no time limit.
  async runCommand(
    command: string,
    board: KanbanBoard,
    opts: {
      cwd: string
      env: Record<string, string>
      timeoutMs: number | null
      signal: AbortSignal
    }
  ): Promise<CommandRunResult> {
    if (isHardBlocked(command, opts.cwd))
      throw new Error(
        "the column's command is blocked by policy and did not run"
      )
    const env = await createEnvironment(
      opts.cwd,
      `kanban:${board.id}`,
      settingsService.getExecutionConfig()
    )
    try {
      const result = await env.exec(command, {
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs ?? Infinity,
        maxOutputBytes: MAX_OUTPUT_BYTES,
        env: opts.env,
        signal: opts.signal,
      })
      if (result.spawnError) throw new Error(result.spawnError)
      return {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        output: stripAnsi(result.stdout.toString("utf8")).slice(
          -COMMAND_OUTPUT_TAIL_CHARS
        ),
      }
    } finally {
      await env.dispose()
    }
  }

  // Background intake: start a sync for each approved board whose interval has
  // passed since its last sync (success or failure, so a failing board waits too).
  syncDue(now = Date.now()): void {
    for (const board of kanban.listBoards()) {
      const hash = approvalHash(board)
      if (!hash || board.approvedHash !== hash) continue
      if (
        board.lastSyncAt !== null &&
        now - board.lastSyncAt < board.syncIntervalMs
      )
        continue
      this.ensureSync(board.id)
    }
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
      // Routine and repaints the board itself: never a desktop notification.
      input: { boardId, quiet: true },
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
      cards: kanban.listCards(boardId).map((card) => ({
        ...card,
        pendingAction: card.continuation ? kanban.pendingAction(card.id) : null,
      })),
      sourceHash: hash,
      layout: workspaceLayout(board.workspace).layout,
      detectedLinks: detectedLinks(board.workspace),
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
