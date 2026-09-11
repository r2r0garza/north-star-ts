// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { GitActions } from "./git-actions"

let container: HTMLDivElement
let root: Root

function click(element: Element) {
  act(() => {
    element.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false })
    )
    element.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, button: 0, ctrlKey: false })
    )
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })
}

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  Object.defineProperty(window, "cowork", {
    configurable: true,
    value: {
      git: {
        status: vi.fn().mockResolvedValue({ isRepo: true, entries: [] }),
      },
    },
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.replaceChildren(...Array.from(document.body.children).filter((child) => child !== container))
  vi.restoreAllMocks()
})

describe("GitActions commit dialog", () => {
  it("clears the commit message when reopened", async () => {
    await act(async () => {
      root.render(<GitActions workspace="/workspace" rightOffset={0} />)
    })

    click(document.querySelector('button[aria-label*="Git actions"]')!)
    click(Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) => item.textContent === "Commit…")!)

    const message = document.querySelector<HTMLTextAreaElement>(
      'textarea[placeholder="Commit message"]'
    )!
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )?.set?.call(message, "stale commit message")
      message.dispatchEvent(new Event("input", { bubbles: true }))
    })
    expect(message.value).toBe("stale commit message")

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })

    click(document.querySelector('button[aria-label*="Git actions"]')!)
    click(Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) => item.textContent === "Commit…")!)

    expect(
      document.querySelector<HTMLTextAreaElement>('textarea[placeholder="Commit message"]')?.value
    ).toBe("")
  })
})
