// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ProvidersTab } from "./llm-settings"
vi.mock("@/components/ui/tabs", () => ({
  TabsContent: ({ children }: any) => <div>{children}</div>,
}))
vi.mock("@/components/ui/select", () => ({
  Select: ({ value, onValueChange, children }: any) => (
    <select
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectContent: ({ children }: any) => <>{children}</>,
  SelectItem: ({ children, ...props }: any) => (
    <option {...props}>{children}</option>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
}))
const create = vi.fn()
const preflight = vi.fn()
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  create.mockReset().mockResolvedValue({ id: "sub" })
  preflight
    .mockReset()
    .mockResolvedValue({ ok: true, version: "2.1.295", hint: "Ready" })
  window.cowork = {
    providers: { create, preflightClaudeSubscription: preflight },
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
async function click(label: string) {
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((node) => node.textContent?.trim() === label)!
      .click()
  )
}
describe("subscription account form", () => {
  it("requires a successful setup check, omits key/upstream fields and creates a completions account", async () => {
    const reload = vi.fn().mockResolvedValue(undefined)
    const state = {
      accounts: [],
      active: null,
      secureOk: false,
      reload,
      setAccounts: vi.fn(),
      setActive: vi.fn(),
    }
    await act(async () => root.render(<ProvidersTab state={state} />))
    expect(container.textContent).toContain(
      "subscription providers use your CLI login"
    )
    expect(container.textContent).not.toContain("Add a provider and API key")
    await click("Add provider")
    const select = [...container.querySelectorAll("select")].find((node) =>
      [...node.options].some((option) => option.value === "claude_subscription")
    )!
    await act(async () => {
      select.value = "claude_subscription"
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    expect(container.textContent).toContain(
      "Claude Code Inference - Experimental"
    )
    expect(container.querySelector('[id="new-base"]')).toBeNull()
    expect(container.querySelector('input[type="password"]')).toBeNull()
    const add = [...container.querySelectorAll("button")].find(
      (node) => node.textContent === "Add"
    )!
    expect(add.disabled).toBe(true)
    await click("Check CLI login")
    expect(add.disabled).toBe(false)
    await click("Add")
    expect(create).toHaveBeenCalledWith({
      provider: "claude_subscription",
      displayName: "Claude Code Inference - Experimental",
      baseUrl: null,
      apiMode: "completions",
    })
    expect(reload).toHaveBeenCalledOnce()
  })
})
