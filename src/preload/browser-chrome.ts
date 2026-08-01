import { contextBridge, ipcRenderer } from "electron"

// Preload for the agent-browser chrome (URL bar + reload) — the secondary
// window's own web contents, NOT the agent-controlled page beneath it. A narrow
// bridge: the chrome asks main to navigate/reload the page view, and subscribes
// to URL changes so the address bar tracks wherever the page ends up (agent- or
// user-driven). This is separate from the main app's `cowork` bridge.
const api = {
  navigate: (url: string): void => {
    void ipcRenderer.invoke("browser:navigate", url)
  },
  reload: (): void => {
    void ipcRenderer.invoke("browser:reload")
  },
  // Toggle element-pick mode (highlight + click-to-select on the page).
  setPickMode: (active: boolean): void => {
    void ipcRenderer.invoke("browser:set-pick-mode", active)
  },
  // Subscribe to page URL updates. Returns an unsubscribe fn.
  onUrl: (cb: (url: string) => void): (() => void) => {
    const listener = (_e: unknown, url: string) => cb(url)
    ipcRenderer.on("browser:url", listener)
    return () => ipcRenderer.off("browser:url", listener)
  },
  // Subscribe to pick-mode changes pushed from main (e.g. auto-off after a pick),
  // so the toggle button reflects the true state. Returns an unsubscribe fn.
  onPickMode: (cb: (active: boolean) => void): (() => void) => {
    const listener = (_e: unknown, active: boolean) => cb(active)
    ipcRenderer.on("browser:pick-mode", listener)
    return () => ipcRenderer.off("browser:pick-mode", listener)
  },
}

contextBridge.exposeInMainWorld("browserChrome", api)

export type BrowserChromeApi = typeof api
