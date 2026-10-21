// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { ToolMediaPreview } from "./tool-media-preview"
import { ToolGroup } from "./tool-group"
import type { ToolUse } from "@/lib/timeline"
import type { ToolMediaReference } from "../../../shared/tool-media"

const image = (id: string, order = 0): ToolMediaReference => ({
  version: 1,
  id,
  order,
  mediaType: "image/jpeg",
  width: 20,
  height: 10,
  byteLength: 3,
  sha256: "abc",
  alt: `Page ${order + 1}`,
  createdAt: 1,
  expiresAt: 9999999999999,
  toolCallId: "call",
  toolName: "read_document",
})
let container: HTMLDivElement
let root: Root
const readMedia = vi.fn()
beforeEach(() => {
  readMedia
    .mockReset()
    .mockResolvedValue({ dataUrl: "data:image/jpeg;base64,YWJj" })
  Object.defineProperty(window, "cowork", {
    configurable: true,
    value: { db: { messages: { readMedia } } },
  })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})
async function render(
  media = [image("first"), image("second", 1)],
  messageId = "result"
) {
  await act(async () =>
    root.render(
      <ToolMediaPreview
        media={media}
        conversationId="conversation"
        messageId={messageId}
      />
    )
  )
}
it("loads one scoped image at a time and releases it on navigation", async () => {
  await render()
  expect(readMedia.mock.calls).toEqual([["conversation", "result", "first"]])
  expect(container.querySelector("img")?.alt).toBe("Page 1")
  await act(async () =>
    (container.querySelectorAll("button")[1] as HTMLButtonElement).click()
  )
  expect(readMedia).toHaveBeenLastCalledWith("conversation", "result", "second")
  expect(container.querySelectorAll("img")).toHaveLength(1)
  expect(container.querySelector("img")?.alt).toBe("Page 2")
})
it("rejects remote URLs and displays missing pixels explicitly", async () => {
  readMedia.mockResolvedValue({ dataUrl: "https://example.com/image.jpg" })
  await render()
  expect(container.querySelector("img")).toBeNull()
  expect(container.textContent).toContain("Image unavailable")
})
it("shows loading, ignores stale loads after changing results, and handles failures", async () => {
  let finish!: (value: { dataUrl: string }) => void
  readMedia.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  await render()
  expect(container.textContent).toContain("Loading stored image")
  readMedia.mockRejectedValueOnce(new Error("missing"))
  await render([image("other")], "other-result")
  await act(async () => finish({ dataUrl: "data:image/jpeg;base64,YWJj" }))
  expect(container.textContent).toContain("Image unavailable")
  expect(container.querySelector("img")).toBeNull()
})
it("handles invalid stored image decoding without retaining the data URL", async () => {
  await render()
  await act(async () =>
    container.querySelector("img")!.dispatchEvent(new Event("error"))
  )
  expect(container.querySelector("img")).toBeNull()
  expect(container.textContent).toContain("could not be decoded")
})
it("bounds the preview list", async () => {
  await render(
    Array.from({ length: 30 }, (_, index) => image(`image-${index}`, index))
  )
  expect(container.textContent).toContain("first 16 images")
  expect(readMedia).toHaveBeenCalledTimes(1)
})
it("does not fetch collapsed tool results and unloads when collapsed", async () => {
  const use: ToolUse = {
    id: "call",
    name: "read_document",
    label: "Read document",
    args: {},
    rawArgs: "{}",
    result: "Page record",
    status: "done",
    media: [image("first")],
    conversationId: "conversation",
    resultMessageId: "result",
  }
  await act(async () =>
    root.render(<ToolGroup calls={[use, { ...use, id: "other" }]} />)
  )
  expect(readMedia).not.toHaveBeenCalled()
  const buttons = () => Array.from(container.querySelectorAll("button"))
  await act(async () => buttons()[0].click())
  expect(readMedia).not.toHaveBeenCalled()
  await act(async () =>
    buttons()
      .find((button) => button.textContent?.includes("Read document"))!
      .click()
  )
  expect(readMedia).toHaveBeenCalledTimes(1)
  expect(readMedia).toHaveBeenLastCalledWith("conversation", "result", "first")
  await act(async () =>
    buttons()
      .find((button) => button.textContent?.includes("Read document"))!
      .click()
  )
  expect(container.querySelector("img")).toBeNull()
  await act(async () => buttons()[1].click())
  expect(readMedia).toHaveBeenCalledTimes(2)
  expect(container.querySelector("img")).not.toBeNull()
  await act(async () => buttons()[0].click())
  expect(container.querySelector("img")).toBeNull()
  await act(async () => buttons()[0].click())
  expect(readMedia).toHaveBeenCalledTimes(2)
  expect(buttons()[1].getAttribute("aria-expanded")).toBe("false")
  await act(async () => buttons()[1].click())
  expect(readMedia).toHaveBeenCalledTimes(3)
})
