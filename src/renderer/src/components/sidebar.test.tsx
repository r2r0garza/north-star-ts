// @vitest-environment happy-dom
import { act, type ComponentProps } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AppSidebar } from "./sidebar"
import { SidebarProvider } from "./ui/sidebar"
import { TooltipProvider } from "./ui/tooltip"

vi.mock("./project-dialog", () => ({ ProjectDialog: () => null }))

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

async function renderSidebar() {
  await act(async () => {
    root.render(
      <TooltipProvider>
        <SidebarProvider>
          <AppSidebar
            view="Chat"
            onViewChange={vi.fn()}
            activeConversationId={null}
            onSelectConversation={vi.fn()}
            onNewConversation={vi.fn()}
            onConversationDeleted={vi.fn()}
            onSettingsClick={vi.fn()}
            onSkillsClick={vi.fn()}
            onAgentsClick={vi.fn()}
            onMcpClick={vi.fn()}
            onDashboardsClick={vi.fn()}
            onWorkflowsClick={vi.fn()}
            refreshKey={0}
            runningConvos={new Set()}
            waitingConvos={new Set()}
          />
        </SidebarProvider>
      </TooltipProvider>
    )
  })
}

describe("conversation search shortcut", () => {
  it.each(["metaKey", "ctrlKey"] as const)(
    "opens and focuses search with Shift+F and %s, even from a text field",
    async (modifier) => {
      await renderSidebar()
      const composer = document.createElement("textarea")
      container.append(composer)
      composer.focus()
      const event = new KeyboardEvent("keydown", {
        key: "F",
        shiftKey: true,
        [modifier]: true,
        bubbles: true,
        cancelable: true,
      })
      await act(async () => composer.dispatchEvent(event))
      const input = document.querySelector<HTMLInputElement>(
        'input[aria-label="Search conversations"]'
      )!
      expect(input).not.toBeNull()
      expect(document.activeElement).toBe(input)
      expect(event.defaultPrevented).toBe(true)
      await act(async () => {
        const setValue = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value"
        )!.set!
        setValue.call(input, "release notes")
        input.dispatchEvent(new Event("input", { bubbles: true }))
      })
      expect(input.value).toBe("release notes")
      await act(async () => {
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "f",
            shiftKey: true,
            [modifier]: true,
            bubbles: true,
            cancelable: true,
          })
        )
      })
      expect(document.activeElement).toBe(input)
      expect(input.value).toBe("release notes")
    }
  )

  it.each([
    { key: "f", metaKey: true },
    { key: "f", ctrlKey: true },
    { key: "F", shiftKey: true },
    { key: "F", shiftKey: true, metaKey: true, altKey: true },
    { key: "F", shiftKey: true, ctrlKey: true, isComposing: true },
  ])("does not open search for unrelated keys: %j", async (keys) => {
    await renderSidebar()
    const event = new KeyboardEvent("keydown", {
      ...keys,
      bubbles: true,
      cancelable: true,
    })
    await act(async () => window.dispatchEvent(event))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(event.defaultPrevented).toBe(false)
  })
})

describe("sidebar Mission Control visibility", () => {
  it("does not expose retired orchestration destinations", async () => {
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
      onMcpClick: vi.fn(),
      onDashboardsClick: vi.fn(),
      onWorkflowsClick: vi.fn(),
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
      container.querySelector<HTMLButtonElement>(
        `button[aria-label="${label}"]`
      ) ?? undefined
    const workflows = button("Workflows")!
    const dashboards = button("Dashboards")!
    expect(
      workflows.compareDocumentPosition(dashboards) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    await act(async () => workflows.click())
    expect(props.onWorkflowsClick).toHaveBeenCalledOnce()
    expect(button("Mission Control")).toBeUndefined()
    expect(button("Processes")).toBeUndefined()
  })
})

describe("project section cap and collapse", () => {
  it("caps a section at 5, keeps the active row, and persists collapse", async () => {
    localStorage.removeItem("sidebar.collapsedProjects")
    const convos = Array.from({ length: 8 }, (_, i) => ({
      id: `c${i}`,
      title: `Convo ${i}`,
      mode: "chat",
      projectId: null,
      pinned: false,
    }))
    window.cowork.db.conversations.list = async () =>
      convos as unknown as Awaited<
        ReturnType<typeof window.cowork.db.conversations.list>
      >
    await act(async () => {
      root.render(
        <TooltipProvider>
          <SidebarProvider>
            <AppSidebar
              view="Chat"
              onViewChange={vi.fn()}
              activeConversationId="c7"
              onSelectConversation={vi.fn()}
              onNewConversation={vi.fn()}
              onConversationDeleted={vi.fn()}
              onSettingsClick={vi.fn()}
              onSkillsClick={vi.fn()}
              onAgentsClick={vi.fn()}
              onMcpClick={vi.fn()}
              onDashboardsClick={vi.fn()}
              onWorkflowsClick={vi.fn()}
              refreshKey={0}
              runningConvos={new Set()}
              waitingConvos={new Set()}
            />
          </SidebarProvider>
        </TooltipProvider>
      )
    })
    const text = () => container.textContent ?? ""
    // c0..c4 plus the active c7; c5 and c6 hidden.
    expect(text()).toContain("Convo 4")
    expect(text()).toContain("Convo 7")
    expect(text()).not.toContain("Convo 5")
    const more = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.startsWith("Show 2 more")
    )!
    await act(async () => more.click())
    expect(text()).toContain("Convo 5")

    const trigger = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("No Project")
    )!
    await act(async () => trigger.click())
    expect(
      JSON.parse(localStorage.getItem("sidebar.collapsedProjects")!)
    ).toEqual(["__none__"])
  })
})
