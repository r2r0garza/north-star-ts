import { BrowserWindow, dialog, ipcMain } from "electron"
import { readFile, writeFile } from "node:fs/promises"
import { exportBoard, importBoard } from "../kanban/export"
import { pickWorkspace } from "../pick-workspace"
import * as kanban from "../db/repositories/kanban"
import type { KanbanService } from "../kanban/service"
import type { KanbanCardRuns } from "../kanban/card-runs"
import {
  asFilter,
  cardNeedsAttention,
  WRITE_APPROVALS,
  type KanbanColumnInput,
  type KanbanWriteApproval,
} from "../../shared/kanban"

// Kanban board IPC (plans 136.1/136.2). Boards are authored by the kanban_write
// agent tool or edited in the board settings sheet; cards move through columns.
export function registerKanbanHandlers(
  service: KanbanService,
  cards: KanbanCardRuns
): void {
  ipcMain.handle("kanban:list", () =>
    kanban.listBoards().map((board) => ({
      ...board,
      needsAttention: kanban.listCards(board.id).some((card) =>
        cardNeedsAttention({
          ...card,
          pendingApproval: cards.pendingApproval(card.id),
        })
      ),
    }))
  )
  ipcMain.handle("kanban:graph", (_e, boardId: string) => {
    const graph = service.graph(boardId)
    if (graph)
      for (const card of graph.cards) {
        card.pendingApproval = cards.pendingApproval(card.id)
        card.queued = cards.queued(card.id)
        card.started = cards.started(card.id)
      }
    return graph
  })
  ipcMain.handle(
    "kanban:answerApproval",
    (_e, cardId: string, decision: "approved" | "denied") =>
      cards.answerApproval(cardId, decision)
  )
  ipcMain.handle("kanban:delete", (_e, boardId: string) =>
    cards.removeBoard(boardId)
  )
  // Share a board as a JSON file: no workspace, cards or approvals.
  ipcMain.handle("kanban:exportFile", async (_e, boardId: string) => {
    const board = kanban.getBoard(boardId)
    if (!board) return { ok: false, reason: "board not found" }
    const safe = board.name.replace(/[\\/:*?"<>|]/g, "-").trim() || "board"
    const options = {
      defaultPath: `${safe}.board.json`,
      filters: [{ name: "Board", extensions: ["json"] }],
    }
    const win = BrowserWindow.getFocusedWindow()
    const picked = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options)
    if (picked.canceled || !picked.filePath) return { ok: true, canceled: true }
    const data = exportBoard(board, kanban.listColumns(boardId))
    await writeFile(
      picked.filePath,
      `${JSON.stringify(data, null, 2)}\n`,
      "utf8"
    )
    return { ok: true }
  })
  // Pick a board file, then the workspace it runs in. The new board's intake
  // recipe waits for approval like any other.
  ipcMain.handle("kanban:importFile", async () => {
    const options = {
      title: "Import a board",
      properties: ["openFile" as const],
      filters: [{ name: "Board", extensions: ["json"] }],
    }
    const win = BrowserWindow.getFocusedWindow()
    const file = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (file.canceled || !file.filePaths[0]) return { ok: true, canceled: true }
    let data: unknown
    try {
      data = JSON.parse(await readFile(file.filePaths[0], "utf8"))
    } catch {
      return { ok: false, reason: "That file isn't valid JSON." }
    }
    const folder = await pickWorkspace({
      message: "Choose the workspace folder this board's cards run in",
      buttonLabel: "Use this folder",
    })
    if (folder.canceled || !folder.path)
      return {
        ok: false,
        reason: "No workspace folder chosen, so the board wasn't imported.",
      }
    try {
      const board = importBoard(data, folder.path)
      return { ok: true, boardId: board.id, name: board.name }
    } catch (err) {
      return { ok: false, reason: (err as Error).message }
    }
  })
  // Returns the sync task id, or null when one is already in flight.
  ipcMain.handle(
    "kanban:sync",
    (_e, boardId: string) => service.ensureSync(boardId)?.id ?? null
  )
  ipcMain.handle("kanban:approveSource", (_e, boardId: string, hash: string) =>
    service.approveSource(boardId, hash)
  )
  // Settings sheet. A filter change that alters the query needs re-approval
  // (the approval hash covers the resolved call).
  ipcMain.handle(
    "kanban:saveSettings",
    (
      _e,
      boardId: string,
      patch: {
        name: string
        filter: unknown
        syncIntervalMs: number
        columns: KanbanColumnInput[]
        writeApproval: KanbanWriteApproval
        actionsPaused: boolean
        worktrees: boolean
        parallelCommands: boolean
        notifications: boolean
      }
    ) => {
      const board = kanban.getBoard(boardId)
      if (!board?.source) return { ok: false, reason: "board not found" }
      if (!patch.name?.trim()) return { ok: false, reason: "name is required" }
      if (patch.columns.some((c) => !c.name?.trim()))
        return { ok: false, reason: "every column needs a name" }
      if (!WRITE_APPROVALS.includes(patch.writeApproval))
        return { ok: false, reason: "unknown write-approval level" }
      try {
        kanban.saveBoard({
          id: boardId,
          name: patch.name.trim(),
          workspace: board.workspace,
          source: board.source,
          filter: asFilter(patch.filter),
          syncIntervalMs: patch.syncIntervalMs,
          columns: patch.columns,
        })
        kanban.setActionSettings(boardId, {
          writeApproval: patch.writeApproval,
          actionsPaused: !!patch.actionsPaused,
        })
        kanban.setRunSettings(boardId, {
          worktrees: patch.worktrees !== false,
          parallelCommands: patch.parallelCommands === true,
        })
        kanban.setNotifications(boardId, patch.notifications !== false)
      } catch (err) {
        if (err instanceof kanban.KanbanColumnInUseError)
          return { ok: false, reason: err.message }
        throw err
      }
      return { ok: true }
    }
  )
  ipcMain.handle(
    "kanban:moveCard",
    (_e, cardId: string, columnId: string | null) =>
      cards.enter(cardId, columnId)
  )
  ipcMain.handle("kanban:approveCard", (_e, cardId: string, outcome?: string) =>
    cards.approve(cardId, outcome)
  )
  ipcMain.handle(
    "kanban:approveAction",
    (_e, cardId: string, actionId: string) =>
      cards.approveAction(cardId, actionId)
  )
  ipcMain.handle("kanban:skipAction", (_e, cardId: string, actionId: string) =>
    cards.skipAction(cardId, actionId)
  )
  ipcMain.handle("kanban:actions", (_e, cardId: string) =>
    kanban.listActions(cardId)
  )
  ipcMain.handle("kanban:sendBack", (_e, cardId: string, feedback?: string) =>
    cards.sendBack(cardId, feedback)
  )
  ipcMain.handle("kanban:retry", (_e, cardId: string, feedback?: string) =>
    cards.retry(cardId, feedback)
  )
  ipcMain.handle("kanban:stop", (_e, cardId: string) => cards.stop(cardId))
  ipcMain.handle(
    "kanban:setOwnWorktree",
    (_e, cardId: string, value: unknown) =>
      cards.setOwnWorktree(cardId, typeof value === "boolean" ? value : null)
  )
  ipcMain.handle("kanban:removeCard", (_e, cardId: string) =>
    cards.remove(cardId)
  )
  ipcMain.handle("kanban:runs", (_e, cardId: string) => kanban.listRuns(cardId))
}
