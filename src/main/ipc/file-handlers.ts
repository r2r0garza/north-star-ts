import { ipcMain, type WebContents } from "electron"
import { watchWorkspaceFiles, type WorkspaceFileWatch } from "../files/watcher"

export function registerFileWatchHandlers(): void {
  const subscriptions = new Map<
    WebContents,
    {
      id: number
      workspace: string
      watch: Promise<WorkspaceFileWatch>
      onDestroyed: () => void
    }
  >()

  const unsubscribe = async (sender: WebContents, id?: number) => {
    const subscription = subscriptions.get(sender)
    if (!subscription || (id !== undefined && subscription.id !== id)) return
    subscriptions.delete(sender)
    sender.removeListener("destroyed", subscription.onDestroyed)
    const watch = await subscription.watch.catch(() => null)
    await watch?.close()
  }

  ipcMain.handle(
    "files:watch",
    async (event, workspace: string, subscriptionId: number) => {
      const sender = event.sender
      await unsubscribe(sender)
      if (!workspace?.trim()) return

      const onDestroyed = () => void unsubscribe(sender, subscriptionId)
      const watch = watchWorkspaceFiles(workspace.trim(), (payload) => {
        if (!sender.isDestroyed()) sender.send("files:changed", payload)
      })
      subscriptions.set(sender, {
        id: subscriptionId,
        workspace: workspace.trim(),
        watch,
        onDestroyed,
      })
      sender.once("destroyed", onDestroyed)

      try {
        await watch
      } catch {
        await unsubscribe(sender, subscriptionId)
        if (!sender.isDestroyed()) {
          sender.send("files:changed", {
            workspace: workspace.trim(),
            paths: [],
            overflow: true,
          })
        }
      }
    }
  )

  ipcMain.handle(
    "files:watchDirectories",
    async (event, subscriptionId: number, directories: string[]) => {
      const subscription = subscriptions.get(event.sender)
      if (!subscription || subscription.id !== subscriptionId) return
      const watch = await subscription.watch.catch(() => null)
      try {
        await watch?.updateDirectories(
          Array.isArray(directories) ? directories : []
        )
      } catch {
        if (!event.sender.isDestroyed()) {
          event.sender.send("files:changed", {
            workspace: subscription.workspace,
            paths: [],
            overflow: true,
          })
        }
      }
    }
  )

  ipcMain.handle("files:unwatch", (event, subscriptionId: number) =>
    unsubscribe(event.sender, subscriptionId)
  )
}
