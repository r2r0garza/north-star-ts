// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Markdown } from "./markdown"
import { toast } from "sonner"

const { mermaidRender } = vi.hoisted(() => ({
  mermaidRender: vi.fn(),
}))

vi.mock("./mermaid", () => ({
  Mermaid: ({ chart }: { chart: string }) => {
    mermaidRender(chart)
    return <div data-testid="mermaid">{chart}</div>
  },
}))

let container: HTMLDivElement
let root: Root
let writeText: ReturnType<typeof vi.fn>

function mount(
  content: string,
  mode?: "settled" | "streaming",
  findQuery?: string,
  preserveSoftBreaks?: boolean,
  conversationId?: string,
  runProps: Partial<React.ComponentProps<typeof Markdown>> = {}
) {
  act(() => {
    root.render(
      <Markdown
        content={content}
        mode={mode}
        findQuery={findQuery}
        preserveSoftBreaks={preserveSoftBreaks}
        conversationId={conversationId}
        {...runProps}
      />
    )
  })
}

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  writeText = vi.fn().mockResolvedValue(undefined)
  mermaidRender.mockClear()
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
  it("runs only settled nonempty Bash fences, preserving Copy and source positions", async () => {
    const onRunBash = vi.fn().mockResolvedValue(undefined)
    const content =
      "Text\n\n```bash\necho one\necho two >&2\n```\n\n```sh\necho no\n```"
    mount(content, "settled", "", false, "c1", {
      onRunBash,
      runDirectory: "/workspace",
    })
    const buttons = container.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="Run Bash code"]'
    )
    expect(buttons).toHaveLength(1)
    expect(buttons[0].title).toContain("/workspace")
    await act(async () => buttons[0].click())
    expect(onRunBash).toHaveBeenCalledWith(content.indexOf("```bash"))
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Copy code"]')!
        .click()
    )
    expect(writeText).toHaveBeenCalledWith("echo one\necho two >&2\n")
    mount(content, "streaming", "", false, "c1", { onRunBash })
    expect(
      container.querySelector('button[aria-label="Run Bash code"]')
    ).toBeNull()
    mount(content)
    expect(
      container.querySelector('button[aria-label="Run Bash code"]')
    ).toBeNull()
  })

  it("prevents duplicate clicks and honors conversation disabled state", async () => {
    let release!: () => void
    const onRunBash = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    mount("```bash\necho yes\n```", "settled", "", false, "c1", { onRunBash })
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Run Bash code"]'
    )!
    act(() => {
      button.click()
      button.click()
    })
    expect(onRunBash).toHaveBeenCalledTimes(1)
    expect(button.disabled).toBe(true)
    await act(async () => release())
    mount("```bash\necho yes\n```", "settled", "", false, "c1", {
      onRunBash,
      runDisabled: true,
    })
    act(() => button.click())
    expect(onRunBash).toHaveBeenCalledTimes(1)
  })

  it("highlights TypeScript fences in settled mode by default", () => {
    mount("```ts\nconst answer = 42\n```")

    const code = container.querySelector("pre code")
    expect(code?.classList.contains("language-ts")).toBe(true)
    expect(code?.classList.contains("hljs")).toBe(true)
    expect(code?.querySelector('[class*="hljs-"]')).not.toBeNull()
  })

  it("leaves TypeScript fences unhighlighted in streaming mode", () => {
    mount("```ts\nconst answer = 42\n```", "streaming")

    const code = container.querySelector("pre code")
    expect(code?.textContent).toBe("const answer = 42\n")
    expect(code?.classList.contains("language-ts")).toBe(true)
    expect(code?.classList.contains("hljs")).toBe(false)
    expect(code?.querySelector('[class*="hljs-"]')).toBeNull()
  })

  it("copies streaming code as exact plain source text", async () => {
    mount("```ts\nconst answer = 42\n```", "streaming")

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

  it("renders Mermaid diagrams without code chrome in settled mode", () => {
    mount("Use `inline` here.\n\n```mermaid\ngraph TD; A-->B\n```")

    expect(mermaidRender).toHaveBeenCalledWith("graph TD; A-->B\n")
    expect(container.querySelector('[data-testid="mermaid"]')).not.toBeNull()
    expect(container.querySelector("button")).toBeNull()
    expect(
      container.querySelector('[data-slot="markdown-code-block"]')
    ).toBeNull()
  })

  it("renders streaming Mermaid source as copyable code", async () => {
    mount("```mermaid\ngraph TD; A-->B\n```", "streaming")

    const block = container.querySelector('[data-slot="markdown-code-block"]')
    const code = block?.querySelector("code.language-mermaid")
    const button = block?.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy code"]'
    )

    expect(mermaidRender).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="mermaid"]')).toBeNull()
    expect(block).not.toBeNull()
    expect(code?.textContent).toBe("graph TD; A-->B\n")
    expect(button).not.toBeNull()

    await act(async () => button?.click())
    expect(writeText).toHaveBeenCalledWith("graph TD; A-->B\n")
  })

  it("replaces streaming Mermaid source with a settled diagram", () => {
    const source = "```mermaid\ngraph TD; A-->B\n```"
    mount(source, "streaming")

    expect(
      container.querySelector('[data-slot="markdown-code-block"]')
    ).not.toBeNull()
    expect(mermaidRender).not.toHaveBeenCalled()

    mount(source, "settled")

    expect(
      container.querySelector('[data-slot="markdown-code-block"]')
    ).toBeNull()
    expect(container.querySelector('[data-testid="mermaid"]')).not.toBeNull()
    expect(mermaidRender).toHaveBeenCalledWith("graph TD; A-->B\n")
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

describe("Markdown conversation find", () => {
  it("marks matches across nested formatting and inline code", () => {
    mount("Find **find** and `FIND`.", "settled", "find")

    const matches = container.querySelectorAll("[data-conversation-find-match]")
    expect(matches).toHaveLength(3)
    expect(Array.from(matches, (match) => match.textContent)).toEqual([
      "Find",
      "find",
      "FIND",
    ])
  })

  it("does not alter rendered text when the query is absent", () => {
    mount("Find **this** text.")

    expect(container.textContent).toBe("Find this text.")
    expect(container.querySelector("[data-conversation-find-match]")).toBeNull()
  })
})

describe("Markdown modes", () => {
  it("can preserve soft line breaks for editable prose previews", () => {
    mount("First line\nSecond line", undefined, undefined, true)

    expect(container.firstElementChild?.className).toContain(
      "[&_p]:whitespace-pre-line"
    )
    expect(container.querySelector("p")?.textContent).toBe(
      "First line\nSecond line"
    )
  })

  it("renders prose, GFM, links, and inline code equivalently", () => {
    const content =
      "A [link](https://example.com) with `inline` code.\n\n| A | B |\n| - | - |\n| 1 | 2 |"

    mount(content, "streaming")
    const streamingHtml = container.innerHTML

    mount(content, "settled")
    expect(container.innerHTML).toBe(streamingHtml)
  })

  it("renders split streaming blocks the same as one settled parse", () => {
    const content =
      "# Audit\n\nIntro with `code`.\n\n## Findings\n\n- one\n- two\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\nClosing para.\n\nTail still stre"

    mount(content, "streaming")
    const streamingHtml = container.innerHTML

    mount(content, "settled")
    expect(container.innerHTML).toBe(streamingHtml)
  })

  it("treats an omitted mode as settled", () => {
    const content = "```mermaid\ngraph TD; A-->B\n```"

    mount(content)
    const defaultHtml = container.innerHTML
    expect(mermaidRender).toHaveBeenCalledTimes(1)

    mermaidRender.mockClear()
    // A fresh root: re-rendering identical content into the same root is
    // memoized and would (correctly) not render the diagram again.
    act(() => root.unmount())
    root = createRoot(container)
    mount(content, "settled")

    expect(container.innerHTML).toBe(defaultHtml)
    expect(mermaidRender).toHaveBeenCalledTimes(1)
  })
})

describe("Markdown file links", () => {
  it("saves local links through IPC rather than opening them externally", async () => {
    const saveFileLink = vi
      .fn()
      .mockResolvedValue("/Users/test/Downloads/preguntas.md")
    const showSuccess = vi
      .spyOn(toast, "success")
      .mockImplementation(() => "saved")
    vi.stubGlobal("cowork", { saveFileLink })
    for (const href of [
      "preguntas.md",
      "file:///repo/preguntas.md",
      "/repo/preguntas.md",
      "sandbox:/mnt/data/preguntas.md",
    ]) {
      mount(`[Download](${href})`, "settled", "", false, "conv-1")
      const link = container.querySelector("a")!
      expect(link.getAttribute("href")).toBe(href)
      expect(link.getAttribute("target")).toBeNull()
      await act(async () => link.click())
      expect(saveFileLink).toHaveBeenLastCalledWith("conv-1", href)
      expect(showSuccess).toHaveBeenLastCalledWith(
        "Saved to Downloads: /Users/test/Downloads/preguntas.md"
      )
    }
    vi.unstubAllGlobals()
  })
  it("shows file failures in the app instead of falling back to the OS", async () => {
    const saveFileLink = vi.fn().mockRejectedValue(new Error("File not found"))
    const showError = vi.spyOn(toast, "error").mockImplementation(() => "error")
    vi.stubGlobal("cowork", { saveFileLink })
    mount("[Download](missing.md)", "settled", "", false, "conv-1")
    await act(async () => container.querySelector("a")!.click())
    expect(showError).toHaveBeenCalledWith("File not found")
    vi.unstubAllGlobals()
  })
  it("keeps web links external and blocks executable schemes", () => {
    mount("[Web](https://example.com) [Unsafe](javascript:alert%281%29)")
    const links = container.querySelectorAll("a")
    expect(links[0].target).toBe("_blank")
    expect(links[0].getAttribute("href")).toBe("https://example.com")
    expect(links[1].getAttribute("href")).toBe("")
  })
})
