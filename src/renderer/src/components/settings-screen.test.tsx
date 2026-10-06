// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SettingsScreen } from "./settings-screen"

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
    system: () => ({ missionControlEnabled: false }),
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

describe("Settings Sidebar feature flag", () => {
  it.each([true, false])(
    "shows Sidebar only when enabled: %s",
    async (enabled) => {
      window.cowork.system = () =>
        ({ missionControlEnabled: enabled }) as ReturnType<
          typeof window.cowork.system
        >
      await act(async () => {
        root.render(
          <SettingsScreen open onOpenChange={vi.fn()} initialTab="sidebar" />
        )
      })
      const sidebarTab = Array.from(
        document.querySelectorAll('[role="tab"]')
      ).find((element) => element.textContent?.trim() === "Sidebar")
      expect(Boolean(sidebarTab)).toBe(enabled)
      expect(
        document.body.textContent?.includes("Show legacy Processes in sidebar")
      ).toBe(enabled)
      if (enabled) {
        expect(getSidebar).toHaveBeenCalledOnce()
      } else {
        expect(getSidebar).not.toHaveBeenCalled()
        const appearance = Array.from(
          document.querySelectorAll('[role="tab"]')
        ).find((element) => element.textContent?.trim() === "Appearance")
        expect(appearance?.getAttribute("aria-selected")).toBe("true")
      }
    }
  )
})
