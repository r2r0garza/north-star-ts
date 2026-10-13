// @vitest-environment happy-dom
import { readFileSync } from "node:fs"
import { afterEach, expect, it, vi } from "vitest"
import type { ChromeTab } from "../../preload/browser-chrome"

it("renders history controls and selects the address on shortcut or native-page request", async () => {
  document.body.innerHTML = readFileSync("src/renderer/browser.html", "utf8")
    .split("<body>")[1]
    .split("</body>")[0]
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
  let onTabs!: (tabs: ChromeTab[]) => void
  let onFocusUrl!: () => void
  const back = vi.fn()
  const forward = vi.fn()
  Object.defineProperty(window, "browserChrome", {
    configurable: true,
    value: {
      platform: "darwin",
      back,
      forward,
      reload: vi.fn(),
      close: vi.fn(),
      navigate: vi.fn(),
      setPickMode: vi.fn(),
      activateTab: vi.fn(),
      onTabs: (cb: typeof onTabs) => {
        onTabs = cb
      },
      onFocusUrl: (cb: typeof onFocusUrl) => {
        onFocusUrl = cb
      },
      onPickMode: vi.fn(),
    },
  })
  await import("./browser-chrome")
  const buttons = [
    ...document.querySelectorAll<HTMLButtonElement>("#bar button"),
  ]
  expect(buttons.slice(0, 3).map((b) => b.id)).toEqual([
    "back",
    "forward",
    "reload",
  ])
  expect(buttons[0].disabled).toBe(true)
  onTabs([
    {
      id: "a",
      title: "A",
      url: "https://example.com",
      loading: false,
      active: true,
      canGoBack: true,
      canGoForward: false,
    },
  ])
  expect(buttons[0].disabled).toBe(false)
  expect(buttons[1].disabled).toBe(true)
  buttons[0].click()
  expect(back).toHaveBeenCalledOnce()
  const input = document.querySelector<HTMLInputElement>("#url")!
  const shortcut = () =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "l",
        metaKey: true,
        cancelable: true,
      })
    )
  shortcut()
  expect(document.activeElement).toBe(input)
  expect(input.selectionStart).toBe(0)
  expect(input.selectionEnd).toBe(input.value.length)
  input.setSelectionRange(3, 3)
  shortcut()
  expect(input.selectionStart).toBe(0)
  expect(input.selectionEnd).toBe(input.value.length)
  input.blur()
  onFocusUrl()
  expect(document.activeElement).toBe(input)
  input.blur()
  onTabs([])
  expect(buttons[0].disabled).toBe(true)
  expect(buttons[1].disabled).toBe(true)
  onFocusUrl()
  expect(input.value).toBe("")
  expect(document.activeElement).toBe(input)
  onTabs([
    {
      id: "b",
      title: "B",
      url: "https://example.org",
      loading: false,
      active: true,
      canGoBack: false,
      canGoForward: true,
    },
  ])
  buttons[1].click()
  expect(forward).toHaveBeenCalledOnce()
})

afterEach(() => {
  document.body.replaceChildren()
})
