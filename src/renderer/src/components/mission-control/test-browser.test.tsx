// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TestBrowserState } from "@/types"
import { TestBrowserNotice, TestBrowserSetting } from "./test-browser"

let container: HTMLDivElement
let root: Root
let install: ReturnType<typeof vi.fn>
let push: ((state: TestBrowserState) => void) | null

const state = (patch: Partial<TestBrowserState> = {}): TestBrowserState => ({
  status: "missing",
  requested: false,
  consent: false,
  progress: null,
  sizeMb: 92.4,
  error: null,
  ...patch,
})

function mount(node: React.ReactNode, initial: TestBrowserState) {
  ;(window as unknown as { cowork: unknown }).cowork = {
    missionControl: {
      testBrowser: {
        get: vi.fn(async () => initial),
        install,
        onChanged: (cb: (s: TestBrowserState) => void) => {
          push = cb
          return () => (push = null)
        },
      },
    },
  }
  return act(async () => root.render(node))
}

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  install = vi.fn(async () => true)
  push = null
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe("TestBrowserNotice (plan 109.06)", () => {
  it("stays hidden until a check asks for a browser", async () => {
    await mount(<TestBrowserNotice />, state())
    expect(container.textContent).toBe("")
  })

  it("asks for the download with its size, and downloads only on a click", async () => {
    await mount(<TestBrowserNotice />, state({ requested: true }))
    expect(container.textContent).toContain("QA needs a browser")
    expect(container.textContent).toContain("about 92 MB")
    expect(install).not.toHaveBeenCalled()
    const button = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Download test browser")
    )!
    await act(async () => button.click())
    expect(install).toHaveBeenCalledOnce()
  })

  it("shows progress, then goes away once installed", async () => {
    await mount(<TestBrowserNotice />, state({ requested: true }))
    await act(async () =>
      push!(
        state({
          requested: true,
          status: "downloading",
          progress: { percent: 40, totalMb: 92.4 },
        })
      )
    )
    expect(container.textContent).toContain("Downloading… 40% of 92 MB")
    await act(async () => push!(state({ status: "installed" })))
    expect(container.textContent).toBe("")
  })
})

describe("TestBrowserSetting", () => {
  it("offers nothing to download when Chrome is installed", async () => {
    await mount(<TestBrowserSetting />, state({ status: "chrome" }))
    expect(container.textContent).toContain("use your installed Google Chrome")
    expect(container.querySelector("button")).toBeNull()
  })

  it("offers the download when there's no browser", async () => {
    await mount(<TestBrowserSetting />, state())
    const button = container.querySelector("button")!
    expect(button.textContent).toBe("Download")
    await act(async () => button.click())
    expect(install).toHaveBeenCalledOnce()
  })
})
