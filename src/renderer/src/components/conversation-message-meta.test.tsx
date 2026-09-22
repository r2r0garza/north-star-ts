// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Message, MessageContent } from "@/components/ui/message"
import {
  ConversationMessageMeta,
  formatConversationTimestamp,
} from "./conversation-message-meta"

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))
vi.mock("sonner", () => ({ toast: { error: toastError } }))

let container: HTMLDivElement
let root: Root
let writeText: ReturnType<typeof vi.fn>

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
  vi.clearAllMocks()
})

function mount(copyAlwaysVisible = false) {
  act(() => {
    root.render(
      <Message align="start">
        <MessageContent>
          <ConversationMessageMeta
            content={"**Markdown**\nsource"}
            createdAt={Date.UTC(2026, 0, 2, 15, 4)}
            align="start"
            copyAlwaysVisible={copyAlwaysVisible}
          />
        </MessageContent>
      </Message>
    )
  })
}

describe("ConversationMessageMeta", () => {
  it("renders localized text and a machine-readable instant", () => {
    mount()

    const time = container.querySelector("time")!
    expect(time.dateTime).toBe("2026-01-02T15:04:00.000Z")
    expect(time.textContent).toBe(
      formatConversationTimestamp(Date.UTC(2026, 0, 2, 15, 4))
    )
  })

  it("keeps timestamps visible while only the latest assistant copy action is always visible", () => {
    mount(true)

    const button = container.querySelector("button")!
    expect(button.classList.contains("conversation-message-meta__always")).toBe(
      true
    )
    expect(container.querySelector("time")!.className).not.toContain(
      "conversation-message-meta__reveal"
    )
  })

  it("reveals other copy actions only on message interaction", () => {
    mount()

    expect(container.querySelector("button")!.className).toContain(
      "conversation-message-meta__reveal"
    )
    expect(container.querySelector("time")!.className).not.toContain(
      "conversation-message-meta__reveal"
    )
  })

  it("copies exact source and resets success feedback", async () => {
    vi.useFakeTimers()
    mount()
    const button = container.querySelector("button")!

    await act(async () => button.click())

    expect(writeText).toHaveBeenCalledWith("**Markdown**\nsource")
    expect(button.getAttribute("aria-label")).toBe("Message copied")

    act(() => vi.advanceTimersByTime(2000))
    expect(button.getAttribute("aria-label")).toBe("Copy message")
  })

  it("reports clipboard failures and remains retryable", async () => {
    writeText.mockRejectedValueOnce(new Error("Denied"))
    mount()
    const button = container.querySelector("button")!

    await act(async () => button.click())

    expect(toastError).toHaveBeenCalledWith("Could not copy message", {
      description: "Denied",
    })
    expect(button.getAttribute("aria-label")).toBe("Copy message")

    await act(async () => button.click())
    expect(writeText).toHaveBeenCalledTimes(2)
    expect(button.getAttribute("aria-label")).toBe("Message copied")
  })
})
