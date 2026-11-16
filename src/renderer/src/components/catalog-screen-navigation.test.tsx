// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { AgentsScreen } from "./agents-screen"
import { SkillsScreen } from "./skills-screen"
import { McpScreen } from "./mcp-screen"

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  const skill = {
    name: "example",
    description: "Example skill",
    body: "Instructions",
    path: "/skills/example/SKILL.md",
    source: "/skills",
    metadata: {},
    allowedTools: [],
  }
  window.cowork = {
    agents: {
      tree: vi.fn(async () => ({
        global: [
          {
            path: "/agents",
            label: "Global",
            kind: "user",
            agents: [
              {
                name: "example",
                label: "Example",
                description: "Example agent",
                body: "Instructions",
                path: "/agents/example.agent.md",
                source: "/agents",
                userInvocable: true,
                refId: "example",
                sourceKind: "north_star",
                scope: "global",
                nativeName: "example",
                diagnostics: [],
                ref: {
                  sourceKind: "north_star",
                  scope: "global",
                  definitionPath: "/agents/example.agent.md",
                  nativeName: "example",
                },
              },
            ],
          },
        ],
        workspaces: [],
        custom: [],
      })),
    },
    skills: {
      tree: vi.fn(async () => ({
        global: [
          { path: "/skills", label: "Global", kind: "user", skills: [skill] },
        ],
        workspaces: [],
        custom: [],
      })),
      list: vi.fn(async () => [skill]),
      read: vi.fn(async () => "---\nname: example\n---\nInstructions"),
    },
    mcp: {
      tree: vi.fn(async () => ({
        global: [
          {
            path: "/mcp.json",
            label: "Global",
            kind: "user",
            servers: [
              {
                name: "example",
                transport: "stdio",
                command: "node",
                args: [],
                env: {},
                url: null,
                headers: {},
                path: "/mcp.json",
                source: "/",
                enabled: true,
                hasOauth: false,
              },
            ],
          },
        ],
        workspaces: [],
        custom: [],
      })),
    },
    settings: {
      getAgentSources: vi.fn(async () => ({ visibleExternalSources: {} })),
    },
  } as unknown as typeof window.cowork
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function escape(handled = false) {
  const event = new KeyboardEvent("keydown", {
    key: "Escape",
    cancelable: true,
    bubbles: true,
  })
  if (handled) event.preventDefault()
  await act(async () => {
    window.dispatchEvent(event)
  })
  expect(event.defaultPrevented).toBe(true)
}

const screens = [
  {
    name: "Agents",
    Screen: AgentsScreen,
    back: "Back to agents",
    close: "Close agents",
  },
  {
    name: "Skills",
    Screen: SkillsScreen,
    back: "Back to skills",
    close: "Close skills",
  },
  {
    name: "MCP",
    Screen: McpScreen,
    back: "Back to servers",
    close: "Close MCP servers",
  },
]

it.each(screens)(
  "navigates $name detail → list → Conversations with Escape",
  async ({ Screen, back, close }) => {
    const onClose = vi.fn()
    await act(async () => root.render(<Screen onClose={onClose} />))
    await act(async () =>
      container.querySelector<HTMLElement>('[data-slot="card"]')!.click()
    )
    expect(container.querySelector(`[aria-label="${back}"]`)).not.toBeNull()
    await escape(true)
    expect(container.querySelector(`[aria-label="${back}"]`)).not.toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    await escape()
    expect(container.querySelector(`[aria-label="${close}"]`)).not.toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    await escape(true)
    expect(onClose).not.toHaveBeenCalled()
    await escape()
    expect(onClose).toHaveBeenCalledOnce()
  }
)

it.each(screens)(
  "preserves $name discard confirmation when escaping an editor",
  async ({ Screen, back, close }) => {
    const onClose = vi.fn()
    const confirm = vi.fn(() => false)
    vi.stubGlobal("confirm", confirm)
    await act(async () => root.render(<Screen onClose={onClose} />))
    await act(async () =>
      container.querySelector<HTMLElement>('[data-slot="card"]')!.click()
    )
    await act(async () =>
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent?.trim() === "Edit")!
        .click()
    )
    await escape()
    expect(confirm).toHaveBeenCalledOnce()
    expect(container.querySelector(`[aria-label="${back}"]`)).not.toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    await escape()
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(container.querySelector(`[aria-label="${close}"]`)).not.toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    await escape()
    expect(onClose).toHaveBeenCalledOnce()
    expect(confirm).toHaveBeenCalledTimes(2)
  }
)
