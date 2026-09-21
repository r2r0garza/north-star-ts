// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Markdown } from "./markdown"

vi.mock("./mermaid", () => ({
  Mermaid: ({ chart }: { chart: string }) => (
    <div data-testid="mermaid">{chart}</div>
  ),
}))

let container: HTMLDivElement
let root: Root
let writeText: ReturnType<typeof vi.fn>

function mount(content: string) {
  act(() => {
    root.render(<Markdown content={content} />)
  })
}

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("Markdown fenced blocks", () => {
  it("copies highlighted code as plain source text", async () => {
    mount("```ts\nconst answer = 42\n```")

    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy code"]'
    )
    expect(button).not.toBeNull()

    await act(async () => button?.click())

    expect(writeText).toHaveBeenCalledWith("const answer = 42\n")
    expect(button?.getAttribute("aria-label")).toBe("Copied")
  })

  it("returns to the copy state after showing copied feedback", async () => {
    vi.useFakeTimers()
    mount("```\nplain text\n```")

    const button = container.querySelector<HTMLButtonElement>("button")
    await act(async () => button?.click())
    expect(button?.getAttribute("aria-label")).toBe("Copied")

    act(() => vi.advanceTimersByTime(2000))
    expect(button?.getAttribute("aria-label")).toBe("Copy code")
  })

  it("does not add copy controls to inline code or Mermaid diagrams", () => {
    mount("Use `inline` here.\n\n```mermaid\ngraph TD; A-->B\n```")

    expect(container.querySelector("button")).toBeNull()
    expect(container.querySelector('[data-testid="mermaid"]')).not.toBeNull()
  })

  it("keeps the sticky action rail outside the horizontal scroll surface", () => {
    mount("```js\nconsole.log('wide block')\n```")

    const block = container.querySelector('[data-slot="markdown-code-block"]')
    const rail = block?.querySelector(".sticky")
    const scrollSurface = block?.querySelector(
      '[data-slot="markdown-code-scroll"]'
    )

    expect(block).not.toBeNull()
    expect(rail?.parentElement).toBe(block)
    expect(scrollSurface?.parentElement).toBe(block)
    expect(scrollSurface?.classList.contains("overflow-x-auto")).toBe(true)
    expect(rail?.contains(scrollSurface ?? null)).toBe(false)
  })
})
