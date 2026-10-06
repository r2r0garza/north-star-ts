// @vitest-environment happy-dom
import { act, type ComponentProps } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AppSidebar } from "./sidebar"
import { SidebarProvider } from "./ui/sidebar"
import { TooltipProvider } from "./ui/tooltip"

vi.mock("./project-dialog", () => ({ ProjectDialog: () => null }))
vi.mock("./conversation-search-dialog", () => ({
  ConversationSearchDialog: () => null,
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  window.cowork = {
    system: () => ({ mainAgentName: "North Star" }),
    db: {
      conversations: { list: async () => [] },
      projects: { list: async () => [] },
      workspaces: { list: async () => [] },
    },
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

describe("sidebar Mission Control visibility", () => {
  it.each([
    [true, false],
    [true, true],
    [false, false],
    [false, true],
  ])("flag %s, legacy preference %s", async (enabled, legacy) => {
    const onMissionControlClick = vi.fn()
    const onProcessClick = vi.fn()
    const props: ComponentProps<typeof AppSidebar> = {
      view: "Chat",
      onViewChange: vi.fn(),
      activeConversationId: null,
      onSelectConversation: vi.fn(),
      onNewConversation: vi.fn(),
      onConversationDeleted: vi.fn(),
      onSettingsClick: vi.fn(),
      onSkillsClick: vi.fn(),
      onAgentsClick: vi.fn(),
      onProcessClick,
      onMissionControlClick,
      showMissionControl: enabled,
      showProcesses: !enabled || legacy,
      onMcpClick: vi.fn(),
      onDashboardsClick: vi.fn(),
      refreshKey: 0,
      runningConvos: new Set(),
      waitingConvos: new Set(),
    }
    await act(async () => {
      root.render(
        <TooltipProvider>
          <SidebarProvider>
            <AppSidebar {...props} />
          </SidebarProvider>
        </TooltipProvider>
      )
    })
    const button = (label: string) =>
      Array.from(container.querySelectorAll("button")).find(
        (element) => element.textContent?.trim() === label
      )
    expect(Boolean(button("Mission Control"))).toBe(enabled)
    expect(Boolean(button("Processes"))).toBe(!enabled || legacy)
    if (enabled) {
      act(() => button("Mission Control")!.click())
      expect(onMissionControlClick).toHaveBeenCalledOnce()
    }
    if (!enabled || legacy) {
      act(() => button("Processes")!.click())
      expect(onProcessClick).toHaveBeenCalledOnce()
    }
  })
})
