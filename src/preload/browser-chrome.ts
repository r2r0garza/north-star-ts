import { contextBridge, ipcRenderer } from "electron"

// Preload for the agent-browser chrome (tab strip + URL bar + reload) — the
// secondary window's own web contents, NOT the agent-controlled pages beneath
// it. A narrow bridge: the chrome drives the active tab (navigate/reload/pick),
// switches/activates tabs, and subscribes to the tab list pushed from main (so
// the strip + URL bar track every tab's state). Separate from the app's `cowork`.

// One tab's state, mirrored from main's TabInfo (src/main/browser/window.ts).
export interface ChromeTab {
  id: string
  title: string
  url: string
  loading: boolean
  active: boolean
}

const api = {
  navigate: (url: string): void => {
    void ipcRenderer.invoke("browser:navigate", url)
  },
  reload: (): void => {
    void ipcRenderer.invoke("browser:reload")
  },
  // Close the active tab (the chrome's "×") when the page is no longer needed.
  close: (): void => {
    void ipcRenderer.invoke("browser:close")
  },
  // Toggle element-pick mode (highlight + click-to-select on the active page).
  setPickMode: (active: boolean): void => {
    void ipcRenderer.invoke("browser:set-pick-mode", active)
  },
  // Click a tab: ask the app to switch to that conversation (bidirectional —
  // the app switch loops back as a new tab list marking it active).
  activateTab: (conversationId: string): void => {
    void ipcRenderer.invoke("browser:activate-conversation", conversationId)
  },
  // Subscribe to the tab list pushed from main. Returns an unsubscribe fn.
  onTabs: (cb: (tabs: ChromeTab[]) => void): (() => void) => {
    const listener = (_e: unknown, tabs: ChromeTab[]) => cb(tabs)
    ipcRenderer.on("browser:tabs", listener)
    return () => ipcRenderer.off("browser:tabs", listener)
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
