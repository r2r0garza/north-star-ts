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
