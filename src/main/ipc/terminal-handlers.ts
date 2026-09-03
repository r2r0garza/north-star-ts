import { ipcMain, type WebContents } from "electron"
import type { TerminalService } from "../terminal/service"
import type { TerminalDataEvent, TerminalExitEvent } from "../terminal/types"

export function registerTerminalHandlers(terminals: TerminalService): void {
  ipcMain.handle("terminal:profiles", () => terminals.profiles())
  ipcMain.handle("terminal:list", () => terminals.list())
  ipcMain.handle(
    "terminal:create",
    (
      _event,
      input: {
        conversationId: string
        workspace: string
        profileId?: string
        cols?: number
        rows?: number
      }
    ) => terminals.create(input)
  )
  ipcMain.handle("terminal:write", (_event, id: string, data: string) => {
    terminals.write(id, data)
  })
  ipcMain.handle(
    "terminal:resize",
    (_event, id: string, cols: number, rows: number) => {
      terminals.resize(id, cols, rows)
    }
  )
  ipcMain.handle("terminal:kill", (_event, id: string) => {
    terminals.kill(id)
  })
  ipcMain.handle(
    "terminal:adopt-conversation",
    (_event, fromConversationId: string, toConversationId: string) => {
      terminals.adoptConversation(fromConversationId, toConversationId)
    }
  )

  const subscriptions = new Map<
    WebContents,
    {
      onData: (event: TerminalDataEvent) => void
      onExit: (event: TerminalExitEvent) => void
      onDestroyed: () => void
    }
  >()
  const unsubscribe = (sender: WebContents) => {
    const listeners = subscriptions.get(sender)
    if (!listeners) return
    terminals.off("data", listeners.onData)
    terminals.off("exit", listeners.onExit)
    sender.removeListener("destroyed", listeners.onDestroyed)
    subscriptions.delete(sender)
  }
  ipcMain.handle("terminal:subscribe", (event) => {
    const sender = event.sender
    if (subscriptions.has(sender)) return
    const listeners = {
      onData: (payload: TerminalDataEvent) => {
        if (!sender.isDestroyed()) sender.send("terminal:data", payload)
      },
      onExit: (payload: TerminalExitEvent) => {
        if (!sender.isDestroyed()) sender.send("terminal:exit", payload)
      },
      onDestroyed: () => unsubscribe(sender),
    }
    terminals.on("data", listeners.onData)
    terminals.on("exit", listeners.onExit)
    subscriptions.set(sender, listeners)
    sender.once("destroyed", listeners.onDestroyed)
  })
  ipcMain.handle("terminal:unsubscribe", (event) => {
    unsubscribe(event.sender)
  })
}
