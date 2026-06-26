import { contextBridge, ipcRenderer } from "electron"
import type { IpcRendererEvent } from "electron"

// Streaming events emitted during a chat turn (mirrors ChatEvent in the agent).
export type ChatEvent =
  | { type: "token"; delta: string }
  | { type: "tool"; name: string; phase: "start" | "done" }

// The typed API exposed to the renderer as `window.cowork`.
// This is the ONLY surface the UI can use to reach the main process.
const api = {
  // Runs a chat turn. `onEvent` receives streamed tokens and tool activity;
  // the returned promise resolves with the final result. The event listener is
  // attached only for the duration of the turn and removed when it settles.
  chat: (
    req: { message: string; workspace?: string; attachments?: string[] },
    onEvent?: (event: ChatEvent) => void
  ) => {
    const listener = (_e: IpcRendererEvent, event: ChatEvent) => onEvent?.(event)
    ipcRenderer.on("chat:event", listener)
    const done = () => ipcRenderer.removeListener("chat:event", listener)
    return (ipcRenderer.invoke("chat", req) as Promise<{
      content?: string
      error?: string
    }>).finally(done)
  },
  pickWorkspace: () =>
    ipcRenderer.invoke("pick-workspace") as Promise<{
      path?: string
      canceled?: boolean
    }>,
  // Native multi-file picker for Chat attachments.
  pickFiles: () =>
    ipcRenderer.invoke("pick-files") as Promise<{
      paths?: string[]
      canceled?: boolean
    }>,
  // Whether the window is currently fullscreen (macOS traffic lights hidden).
  isFullScreen: () => ipcRenderer.invoke("is-fullscreen") as Promise<boolean>,
  // Subscribe to fullscreen changes. Returns an unsubscribe function.
  onFullScreenChange: (cb: (value: boolean) => void) => {
    const listener = (_e: IpcRendererEvent, value: boolean) => cb(value)
    ipcRenderer.on("window:fullscreen", listener)
    return () => {
      ipcRenderer.removeListener("window:fullscreen", listener)
    }
  },
}

contextBridge.exposeInMainWorld("cowork", api)

export type CoworkApi = typeof api
