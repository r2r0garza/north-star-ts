// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import type { TimelineItem, ToolUse } from "@/lib/timeline"
import {
  LiveTranscriptTurn,
  SettledTranscript,
  type LiveSegment,
} from "./transcript"

// Count renders at the leaves each row owns: settled/live text through
// Markdown and ConversationFindText, tool rows through ToolGroup.
const renders = vi.hoisted(() => ({ byKey: new Map<string, number>() }))
function bump(key: string) {
  renders.byKey.set(key, (renders.byKey.get(key) ?? 0) + 1)
}

vi.mock("@/components/markdown", () => ({
  Markdown: ({
    content,
    mode = "settled",
  }: {
    content: string
    mode?: string
  }) => {
    bump(`md:${mode}:${content.slice(0, 12)}`)
    return (
      <div data-testid="markdown" data-mode={mode}>
        {content}
      </div>
    )
  },
}))
vi.mock("@/components/conversation-find-text", () => ({
  ConversationFindText: ({ text, query }: { text: string; query: string }) => {
    bump(`find:${text}`)
    return <span data-query={query}>{text}</span>
  },
}))
vi.mock("@/components/tool-group", () => ({
  ToolGroup: ({ calls }: { calls: ToolUse[] }) => {
    bump(`tools:${calls.map((c) => c.id).join(",")}`)
    return <div data-testid="tool-group">{calls.length} tool uses</div>
  },
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  renders.byKey.clear()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function toolCall(id: string, status: ToolUse["status"] = "done"): ToolUse {
  return { id, name: "read_file", args: {}, status } as ToolUse
}

const items: TimelineItem[] = [
  {
    kind: "text",
    key: "u1",
    role: "user",
    content: "question one",
    createdAt: 1,
  },
  { kind: "tools", key: "t1", calls: [toolCall("c1")] },
  {
    kind: "text",
    key: "a1",
    role: "assistant",
    content: "answer one",
    createdAt: 2,
  },
  {
    kind: "text",
    key: "u2",
    role: "user",
    content: "question two",
    createdAt: 3,
  },
]

const noop = () => {}

interface RenderOptions {
  settled?: TimelineItem[]
  anchorLast?: boolean
  findQuery?: string
  latestAssistantKey?: string | null
  live?: LiveSegment[] | null
  commandWait?: boolean
  streamRetrying?: boolean
}

function render({
  settled = items,
  anchorLast = false,
  findQuery = "",
  latestAssistantKey = "a1",
  live = [],
  commandWait = false,
  streamRetrying = false,
}: RenderOptions = {}) {
  const content = (live ?? [])
    .map((segment) => (segment.kind === "text" ? segment.text : ""))
    .join("")
  act(() => {
    root.render(
      <MessageScrollerProvider>
        <MessageScroller>
          <MessageScrollerViewport>
            <MessageScrollerContent>
              <SettledTranscript
                items={settled}
                anchorLast={anchorLast}
                findQuery={findQuery}
                latestAssistantKey={latestAssistantKey}
                workspace=""
                onOpenHtml={noop}
                onReviewFiles={noop}
              />
              {live && (
                <LiveTranscriptTurn
                  segments={live}
                  content={content}
                  firstTextAt={content ? 10 : null}
                  commandWait={commandWait}
                  streamRetrying={streamRetrying}
                  findQuery={findQuery}
                  workspace=""
                  onOpenHtml={noop}
                  onReviewFiles={noop}
                />
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
        </MessageScroller>
      </MessageScrollerProvider>
    )
  })
}

function settledRenderCounts() {
  return {
    user1: renders.byKey.get("find:question one"),
    tools: renders.byKey.get("tools:c1"),
    assistant: renders.byKey.get("md:settled:answer one"),
    user2: renders.byKey.get("find:question two"),
  }
}

function anchors() {
  return Array.from(
    container.querySelectorAll<HTMLElement>("[data-scroll-anchor]")
  ).map((element) => element.dataset.scrollAnchor)
}

describe("transcript render boundaries", () => {
  it("does not rerender settled rows while live text streams", () => {
    render({ live: [{ kind: "text", text: "Streaming" }] })
    const before = settledRenderCounts()
    expect(before).toEqual({ user1: 1, tools: 1, assistant: 1, user2: 1 })

    for (const text of ["Streaming a", "Streaming ab", "Streaming abc"]) {
      render({ live: [{ kind: "text", text }] })
    }

    expect(settledRenderCounts()).toEqual(before)
    expect(container.textContent).toContain("Streaming abc")
  })

  it("does not rerender unchanged earlier live segments", () => {
    const tools: LiveSegment = { kind: "tools", calls: [toolCall("live1")] }
    const preamble: LiveSegment = { kind: "text", text: "Preamble text" }
    render({ live: [preamble, tools, { kind: "text", text: "Next" }] })
    render({ live: [preamble, tools, { kind: "text", text: "Next token" }] })

    expect(renders.byKey.get("md:streaming:Preamble tex")).toBe(1)
    expect(renders.byKey.get("tools:live1")).toBe(1)
    expect(renders.byKey.get("md:streaming:Next token")).toBe(1)
  })

  it("renders live segments in streamed order with streaming Markdown", () => {
    render({
      live: [
        { kind: "text", text: "first" },
        { kind: "tools", calls: [toolCall("x", "running")] },
        { kind: "text", text: "second" },
      ],
    })

    const live = container.querySelectorAll(
      "[data-slot='message-scroller-item']"
    )
    const turn = live[live.length - 1]
    expect(
      Array.from(turn.querySelectorAll("[data-testid]")).map(
        (element) => element.getAttribute("data-mode") ?? element.textContent
      )
    ).toEqual(["streaming", "1 tool uses", "streaming"])
    expect(turn.textContent?.indexOf("first")).toBeLessThan(
      turn.textContent?.indexOf("second") ?? -1
    )
  })

  it("moves the scroll anchor between the live turn and the last settled row", () => {
    render({ live: [] })
    expect(anchors()).toEqual(["false", "false", "false", "false", "true"])

    render({ live: null, anchorLast: true })
    expect(anchors()).toEqual(["false", "false", "false", "true"])
    // Moving the anchor rerenders only the row whose anchor changed.
    expect(settledRenderCounts()).toEqual({
      user1: 1,
      tools: 1,
      assistant: 1,
      user2: 2,
    })

    render({ live: null, anchorLast: false })
    expect(anchors()).toEqual(["false", "false", "false", "false"])
  })

  it("propagates find query changes to settled and live rows", () => {
    render({ live: [{ kind: "text", text: "live" }] })
    render({ live: [{ kind: "text", text: "live" }], findQuery: "question" })

    expect(
      Array.from(container.querySelectorAll("[data-query]")).map((element) =>
        element.getAttribute("data-query")
      )
    ).toEqual(["question", "question"])
    expect(settledRenderCounts().user1).toBe(2)
    expect(renders.byKey.get("md:streaming:live")).toBe(2)
  })

  it("shows the waiting marker before the first live event", () => {
    render({ live: [] })
    expect(container.textContent).toContain("Thinking…")

    render({ live: [], streamRetrying: true })
    expect(container.textContent).toContain(
      "Connection interrupted — retrying…"
    )

    render({ live: [], commandWait: true })
    expect(container.textContent).toContain("Waiting for background command…")
  })

  it("keeps the latest settled assistant copy action always visible", () => {
    const alwaysVisible = () =>
      container.querySelectorAll(".conversation-message-meta__always").length

    render({ live: null, latestAssistantKey: "a1" })
    expect(alwaysVisible()).toBe(1)

    render({ live: null, latestAssistantKey: null })
    expect(alwaysVisible()).toBe(0)
  })
})
