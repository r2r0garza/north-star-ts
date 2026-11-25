// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SettingsScreen } from "./settings-screen"
import { TooltipProvider } from "./ui/tooltip"

vi.mock("./llm-settings", () => ({
  useLlmSettings: () => ({ accounts: [], active: null }),
  ProvidersTab: () => null,
  ModelsTab: () => null,
  ModelMappingsTab: () => null,
}))

let container: HTMLDivElement
let root: Root
let getSidebar: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  getSidebar = vi.fn(async () => ({ showLegacyProcesses: false }))
  const empty = async () => []
  window.cowork = {
    system: () => ({ mainAgentName: "North Star" }),
    settings: {
      getSidebar,
      getExecution: async () => ({
        backend: "local",
        localProfile: "host-access",
        sandbox: {},
      }),
      getPermissions: async () => ({}),
      getIndexing: async () => ({
        summarizeMessageThreshold: 0,
        summarizeTokenThreshold: 80000,
      }),
      getMemory: async () => ({ enabled: false }),
      getTitleGeneration: async () => ({}),
      getBrowser: async () => ({}),
      getIde: async () => ({}),
      ideOptions: empty,
      getNotifications: async () => ({}),
      getConversations: async () => ({}),
      checkRuntimes: async () => ({}),
      localProfileCapabilities: async () => ({
        "host-access": { supported: true },
        "workspace-write": { supported: true },
        "read-only": { supported: true },
      }),
      getTheme: async () => ({ accent: null, neutral: null }),
    },
    providers: { listWithModels: empty },
    skills: { sources: empty },
    agents: { sources: empty },
    mcp: { sources: empty },
  } as unknown as typeof window.cowork
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe("retired sidebar settings", () => {
  it("does not expose legacy Processes preferences", async () => {
    await act(async () => {
      root.render(
        <SettingsScreen open onOpenChange={vi.fn()} initialTab="sidebar" />
      )
    })
    expect(document.body.textContent).not.toContain("Show legacy Processes")
    expect(getSidebar).not.toHaveBeenCalled()
  })
})

describe("Windows shell for conversations", () => {
  const render = async (platform: string) => {
    const setExecution = vi.fn(async (next: unknown) => next)
    Object.assign(window.cowork, { platform })
    Object.assign(window.cowork.settings, {
      getExecution: async () => ({
        backend: "local",
        localProfile: "host-access",
        windowsShell: "powershell",
        sandbox: { prompted: true, autoApprove: false, categories: {} },
      }),
      setExecution,
    })
    await act(async () => {
      root.render(
        <TooltipProvider>
          <SettingsScreen open onOpenChange={vi.fn()} initialTab="backend" />
        </TooltipProvider>
      )
    })
    return setExecution
  }

  it("offers PowerShell (the default) or cmd on Windows and saves the choice", async () => {
    const setExecution = await render("win32")
    const trigger = document.getElementById("windows-shell-select")!
    expect(trigger.textContent).toContain("PowerShell")
    expect(document.body.textContent).toContain("PowerShell 7 (pwsh)")
    await act(async () => {
      trigger.focus()
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
      )
    })
    await act(async () => {
      const option = [
        ...document.querySelectorAll<HTMLElement>('[role="option"]'),
      ].find((item) => item.textContent === "Command Prompt (cmd)")!
      option.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))
      option.click()
    })
    expect(setExecution).toHaveBeenCalledWith(
      expect.objectContaining({ windowsShell: "cmd" })
    )
  })

  it.each(["darwin", "linux"])("hides the shell choice on %s", async (p) => {
    await render(p)
    expect(document.getElementById("local-profile-select")).not.toBeNull()
    expect(document.getElementById("windows-shell-select")).toBeNull()
  })
})
