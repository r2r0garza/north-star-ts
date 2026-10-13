// @vitest-environment happy-dom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { ActivityPanel } from "./activity-panel"

vi.mock("@/components/ui/tooltip", () => ({
  TooltipButton: ({ tooltip: _tooltip, children, ...props }: any) => (
    <button {...props}>{children}</button>
  ),
}))
vi.mock("@/components/ui/sidebar", () => ({
  SidebarHeader: ({ children }: any) => <div>{children}</div>,
  SidebarContent: ({ children }: any) => <div>{children}</div>,
  SidebarGroup: ({ children }: any) => <div>{children}</div>,
  SidebarGroupLabel: ({ children }: any) => <div>{children}</div>,
  SidebarGroupContent: ({ children }: any) => <div>{children}</div>,
}))

it("updates sidebar history controls and scopes address selection to a visible browser", async () => {
  let onTabs!: (tabs: any[]) => void
  let onFocus!: () => void
  const unsubscribe = vi.fn()
  const browserBack = vi.fn()
  const browserForward = vi.fn()
  Object.defineProperty(window, "cowork", {
    configurable: true,
    value: {
      platform: "win32",
      browserBack,
      browserForward,
      onBrowserTabs: (cb: typeof onTabs) => {
        onTabs = cb
        return () => {}
      },
      onBrowserFocusUrl: (cb: typeof onFocus) => {
        onFocus = cb
        return unsubscribe
      },
      onBrowserPickMode: () => () => {},
      reportBrowserBounds: vi.fn(),
      setBrowserVisible: vi.fn(),
    },
  })
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  const render = async (open: boolean, browserObscured = false) => {
    await act(async () =>
      root.render(
        <ActivityPanel
          conversationId="a"
          open={open}
          browserObscured={browserObscured}
          tabs={[{ id: "browser", kind: "browser" }]}
          activeTabId="browser"
          workspace=""
          onAddFileSelection={() => {}}
          onOpenChange={() => {}}
          onActiveTabChange={() => {}}
          onOpenTab={() => {}}
          onCloseTab={() => {}}
          onOpenTask={() => {}}
          historyExpanded={false}
          onHistoryExpandedChange={() => {}}
        />
      )
    )
  }
  try {
    await render(true)
    const back = container.querySelector<HTMLButtonElement>(
      '[aria-label="Back"]'
    )!
    const forward = container.querySelector<HTMLButtonElement>(
      '[aria-label="Forward"]'
    )!
    expect(back.disabled).toBe(true)
    expect(forward.disabled).toBe(true)
    await act(async () =>
      onTabs([
        {
          active: true,
          url: "https://example.com",
          canGoBack: true,
          canGoForward: true,
        },
      ])
    )
    back.click()
    forward.click()
    expect(browserBack).toHaveBeenCalledOnce()
    expect(browserForward).toHaveBeenCalledOnce()
    const input = container.querySelector<HTMLInputElement>(
      '[aria-label="Browser URL"]'
    )!
    const shortcut = () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "l",
          ctrlKey: true,
          cancelable: true,
        })
      )
    shortcut()
    expect(document.activeElement).toBe(input)
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)
    input.setSelectionRange(2, 2)
    shortcut()
    expect(input.selectionStart).toBe(0)
    input.blur()
    onFocus()
    expect(document.activeElement).toBe(input)
    input.blur()
    await render(true, true)
    shortcut()
    expect(document.activeElement).not.toBe(input)
    expect(unsubscribe).toHaveBeenCalled()
    await render(false)
    shortcut()
    expect(document.activeElement).not.toBe(input)
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})
