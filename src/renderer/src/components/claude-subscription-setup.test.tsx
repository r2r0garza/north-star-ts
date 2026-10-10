// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ClaudeSubscriptionSetup } from "./claude-subscription-setup"
let container: HTMLDivElement
let root: Root
const preflight = vi.fn()
const refresh = vi.fn()
const ready = {
  ok: true,
  installed: true,
  version: "2.1.295",
  compatible: true,
  loggedIn: true,
  hint: "Personal login verified",
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  preflight.mockReset().mockResolvedValue(ready)
  refresh
    .mockReset()
    .mockResolvedValue({
      ok: true,
      preflight: ready,
      catalog: { source: "retained", hint: "Existing models retained" },
    })
  window.cowork = {
    providers: {
      preflightClaudeSubscription: preflight,
      refreshClaudeSubscriptionModels: refresh,
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
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === text
  )!
  await act(async () => button.click())
}
describe("subscription setup controls", () => {
  it("explains shared CLI ownership and billing without key or URL inputs", async () => {
    await act(async () => root.render(<ClaudeSubscriptionSetup />))
    expect(container.querySelector("input")).toBeNull()
    expect(container.textContent).toContain("claude auth login")
    expect(container.textContent).toContain("usage credits or overages")
    expect(container.textContent).toContain(
      "All subscription entries share that login"
    )
    expect(preflight).not.toHaveBeenCalled()
  })
  it("reports readiness and supports recheck after login changes", async () => {
    const checked = vi.fn()
    await act(async () =>
      root.render(<ClaudeSubscriptionSetup onChecked={checked} />)
    )
    await click("Check CLI login")
    expect(checked).toHaveBeenLastCalledWith(true)
    expect(container.textContent).toContain("Claude Code 2.1.295")
    preflight.mockResolvedValue({
      ...ready,
      ok: false,
      hint: "Recheck personal login",
    })
    await click("Recheck CLI login")
    expect(checked).toHaveBeenLastCalledWith(false)
    expect(container.textContent).toContain("Recheck personal login")
  })
  it("refreshes an account catalog and surfaces retained status", async () => {
    const changed = vi.fn().mockResolvedValue(undefined)
    await act(async () =>
      root.render(
        <ClaudeSubscriptionSetup accountId="sub" onModelsChanged={changed} />
      )
    )
    await click("Refresh CLI models")
    expect(refresh).toHaveBeenCalledWith("sub")
    expect(changed).toHaveBeenCalledOnce()
    expect(container.textContent).toContain("Existing models retained")
  })
  it("keeps setup unready on IPC failure without displaying raw errors", async () => {
    const checked = vi.fn()
    preflight.mockRejectedValue(new Error("private credential"))
    await act(async () =>
      root.render(<ClaudeSubscriptionSetup onChecked={checked} />)
    )
    await click("Check CLI login")
    expect(checked).toHaveBeenLastCalledWith(false)
    expect(container.textContent).not.toContain("private credential")
    expect(container.textContent).toContain("Could not check")
  })
})
