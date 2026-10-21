// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { ToolUse } from "@/lib/timeline"
import { ToolGroup } from "./tool-group"

let container: HTMLDivElement
let root: Root
const call = (fields: Partial<ToolUse> = {}): ToolUse => ({
  id: "call",
  name: "unknown_tool",
  label: "Inspect files",
  args: null,
  rawArgs: "not json",
  status: "running",
  ...fields,
})
const approval: NonNullable<ToolUse["approval"]> = {
  requestId: "approval",
  status: "pending",
  summary: "Inspect",
  reason: "Needs permission",
}
const buttons = () => [
  ...container.querySelectorAll<HTMLButtonElement>(
    '[data-slot="trace-collapsible-trigger"]'
  ),
]
async function render(calls: ToolUse[]) {
  await act(async () => root.render(<ToolGroup calls={calls} />))
}
async function click(index: number) {
  await act(async () => buttons()[index].click())
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

it.each([
  ["running", undefined, "running", "Running"],
  ["running", approval, "pending", "Awaiting approval"],
  ["done", undefined, null, "Inspect files"],
  ["error", undefined, "error", "Failed"],
  ["interrupted", undefined, null, "Interrupted"],
] as const)(
  "presents %s with approval %j without opening it",
  async (status, gate, traceStatus, label) => {
    await render([call({ status, approval: gate })])
    expect(buttons()).toHaveLength(1)
    expect(buttons()[0].getAttribute("aria-expanded")).toBe("false")
    expect(container.textContent).not.toContain("1 tool use")
    expect(buttons()[0].getAttribute("aria-expanded")).toBe("false")
    expect(
      buttons()[0]
        .querySelector('[data-slot="trace-line"]')
        ?.getAttribute("data-status")
    ).toBe(traceStatus)
    expect(buttons()[0].textContent).toContain(label)
    expect(
      buttons()[0].querySelector(
        status === "interrupted" ? ".lucide-circle-slash" : ".lucide-wrench"
      )
    ).not.toBeNull()
    expect(buttons()[0].querySelector(".animate-spin")).toBeNull()
  }
)

it("summarizes mixed states with running, approval, failure, settled precedence and counts", async () => {
  const mixed = [
    call(),
    call({ id: "approval", approval }),
    call({ id: "error", status: "error" }),
    call({ id: "interrupted", status: "interrupted" }),
  ]
  await render(mixed)
  expect(buttons()[0].textContent).toContain(
    "4 tool uses — 1 running, 1 awaiting approval, 1 failed, 1 interrupted"
  )
  expect(buttons()[0].querySelector('[data-status="running"]')).not.toBeNull()
  await render(mixed.slice(1))
  expect(buttons()[0].querySelector('[data-status="pending"]')).not.toBeNull()
  await render(mixed.slice(2))
  expect(buttons()[0].querySelector('[data-status="error"]')).not.toBeNull()
  await render([call({ status: "done" })])
  expect(buttons()[0].textContent).toBe("Inspect files")
  expect(buttons()[0].querySelector("[data-status]")).toBeNull()
  await render([])
  expect(buttons()[0].textContent).toBe("0 tool uses")
})

it("preserves keyed open choices through updates and reorders, but resets rows on group close", async () => {
  await render([call({ approval }), call({ id: "other", label: "Other" })])
  await click(0)
  await click(1)
  expect(container.textContent).toContain("not json")
  await render([
    call({ id: "other", label: "Other" }),
    call({ status: "done", result: "finished" }),
  ])
  expect(buttons()[2].getAttribute("aria-expanded")).toBe("true")
  expect(container.textContent).toContain("finished")
  await render([
    call({ status: "error", result: "ERROR[read]: failed" }),
    call({ id: "other", label: "Other" }),
  ])
  expect(buttons()[1].getAttribute("aria-expanded")).toBe("true")
  expect(container.textContent).toContain("ERROR[read]: failed")
  await click(0)
  expect(buttons()).toHaveLength(1)
  await click(0)
  expect(buttons()[1].getAttribute("aria-expanded")).toBe("false")
})

it("retains raw/parsed arguments, output clipping, empty results, errors and interruption notes", async () => {
  await render([call({ status: "done", result: "x".repeat(4001) })])
  await click(0)
  expect(container.querySelectorAll("pre")[0].textContent).toBe("not json")
  expect(container.querySelectorAll("pre")[1].textContent).toBe(
    "x".repeat(4000) + "\n…[truncated]"
  )
  await render([call({ status: "done", args: { path: "a" }, result: "" })])
  expect(container.querySelectorAll("pre")[0].textContent).toBe(
    '{\n  "path": "a"\n}'
  )
  expect(container.querySelectorAll("pre")[1].textContent).toBe("")
  await render([call({ status: "running" })])
  expect(container.querySelectorAll("pre")).toHaveLength(1)
  await render([call({ status: "interrupted" })])
  expect(container.textContent).toContain("This request was interrupted")
  await render([call({ label: "", status: "done" })])
  expect(buttons()[0].textContent).toContain("unknown_tool")
})

it.each([
  ["completed", null],
  ["failed", "error"],
  ["stopped", null],
  ["active", "running"],
  ["pending", "pending"],
  ["novel_state", null],
])(
  "keeps delegated %s neutral or explicitly mapped, metadata and independent navigation",
  async (status, mapped) => {
    const navigate = vi.fn()
    window.addEventListener("open-conversation", navigate)
    try {
      const result = {
        id: "worker",
        status,
        identity: "Reviewer",
        access: "read-only",
        content: "x".repeat(4001),
        conversationId: "private",
        durationMs: 1500,
        usage: { totalTokens: 123 },
        branch: "worker-branch",
        commits: ["sha"],
        touchedFileCount: 2,
        mergeability: "clean",
        integrationBranch: "main",
        integrationStatus: "integrated",
      }
      await render([
        call({
          name: "spawn_subagents",
          status: "done",
          result: JSON.stringify({ results: [result] }),
        }),
      ])
      await click(0)
      expect(buttons()[1].textContent).toContain(status)
      expect(
        buttons()[1]
          .querySelector('[data-slot="trace-line"]')
          ?.getAttribute("data-status")
      ).toBe(mapped)
      await click(1)
      for (const text of [
        "Reviewer",
        "read-only",
        "1.5 s",
        "123 tokens",
        "2 files",
        "1 commits",
        "worker-branch",
        "merge: clean",
        "integration: integrated",
        "main",
        "…[truncated]",
      ])
        expect(container.textContent).toContain(text)
      expect(container.querySelector("button button")).toBeNull()
      await act(async () =>
        [...container.querySelectorAll("button")]
          .find((b) => b.textContent === "Open transcript")!
          .click()
      )
      expect(navigate).toHaveBeenCalledTimes(1)
      expect((navigate.mock.calls[0][0] as CustomEvent).detail).toEqual({
        conversationId: "private",
      })
    } finally {
      window.removeEventListener("open-conversation", navigate)
    }
  }
)
