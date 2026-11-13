import { ipcMain } from "electron"
import * as kanban from "../db/repositories/kanban"
import type { KanbanService } from "../kanban/service"

// Kanban board IPC (plan 136.1). Boards are authored by the kanban_write agent
// tool; the board view lists, reads, syncs, approves, and deletes them.
export function registerKanbanHandlers(service: KanbanService): void {
  ipcMain.handle("kanban:list", () => kanban.listBoards())
  ipcMain.handle("kanban:graph", (_e, boardId: string) =>
    service.graph(boardId)
  )
  ipcMain.handle("kanban:delete", (_e, boardId: string) =>
    kanban.deleteBoard(boardId)
  )
  // Returns the sync task id, or null when one is already in flight.
  ipcMain.handle(
    "kanban:sync",
    (_e, boardId: string) => service.ensureSync(boardId)?.id ?? null
  )
  ipcMain.handle("kanban:approveSource", (_e, boardId: string, hash: string) =>
    service.approveSource(boardId, hash)
  )
}
