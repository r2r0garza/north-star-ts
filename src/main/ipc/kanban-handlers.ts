import { ipcMain } from "electron"
import * as kanban from "../db/repositories/kanban"
import type { KanbanService } from "../kanban/service"
import type { KanbanCardRuns } from "../kanban/card-runs"
import { asFilter, type KanbanColumnInput } from "../../shared/kanban"

// Kanban board IPC (plans 136.1/136.2). Boards are authored by the kanban_write
// agent tool or edited in the board settings sheet; cards move through columns.
export function registerKanbanHandlers(
  service: KanbanService,
  cards: KanbanCardRuns
): void {
  ipcMain.handle("kanban:list", () => kanban.listBoards())
  ipcMain.handle("kanban:graph", (_e, boardId: string) => {
    const graph = service.graph(boardId)
    if (graph)
      for (const card of graph.cards)
        card.pendingApproval = cards.pendingApproval(card.id)
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
      }
    ) => {
      const board = kanban.getBoard(boardId)
      if (!board?.source) return { ok: false, reason: "board not found" }
      if (!patch.name?.trim()) return { ok: false, reason: "name is required" }
      if (patch.columns.some((c) => !c.name?.trim()))
        return { ok: false, reason: "every column needs a name" }
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
  ipcMain.handle("kanban:approveCard", (_e, cardId: string) =>
    cards.approve(cardId)
  )
  ipcMain.handle("kanban:sendBack", (_e, cardId: string, feedback?: string) =>
    cards.sendBack(cardId, feedback)
  )
  ipcMain.handle("kanban:retry", (_e, cardId: string, feedback?: string) =>
    cards.retry(cardId, feedback)
  )
  ipcMain.handle("kanban:stop", (_e, cardId: string) => cards.stop(cardId))
  ipcMain.handle("kanban:removeCard", (_e, cardId: string) =>
    cards.remove(cardId)
  )
  ipcMain.handle("kanban:runs", (_e, cardId: string) => kanban.listRuns(cardId))
}
