// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { TranscriptTools } from "./transcript-tools"
import type { ToolUse } from "@/lib/timeline"

vi.mock("@/components/conversation-artifact", () => ({
  ConversationArtifact: () => <figure>Saved chart</figure>,
}))
let container: HTMLDivElement
let root: Root
const call = (id: string, fields: Partial<ToolUse> = {}): ToolUse => ({
  id,
  name: "read_file_tool",
  label: id,
  args: {},
  rawArgs: "{}",
  status: "done",
  ...fields,
})
const snapshot = (
  status = "running",
  output = "first\n",
  exitCode: number | null = null
) => JSON.stringify({ status, sessionId: "s", output, exitCode, signal: null })
const launch = (fields: Partial<ToolUse> = {}) =>
  call("launch", {
    name: "exec_command",
    label: "Checking project",
    args: { command: "echo output" },
    status: "running",
    ...fields,
  })
const render = async (calls: ToolUse[]) =>
  act(async () => root.render(<TranscriptTools calls={calls} />))
const triggers = () => [
  ...container.querySelectorAll<HTMLButtonElement>(
    '[data-slot="trace-collapsible-trigger"]'
  ),
]
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

it("shows a launch outside a collapsed group, updates it in place, then folds final output into that group", async () => {
  const prior = [call("one"), call("two")]
  await render([...prior, launch()])
  const group = triggers()[0]
  expect(group.textContent).toContain("2 tool uses")
  expect(group.getAttribute("aria-expanded")).toBe("false")
  expect(container.textContent).toContain("echo output")
  expect(container.textContent).toContain("Waiting for output")
  const active = container.querySelector('[data-slot="active-command"]')
  await render([
    ...prior,
    launch({ status: "done", result: snapshot(), commandLive: snapshot() }),
  ])
  expect(container.querySelector('[data-slot="active-command"]')).toBe(active)
  expect(active?.textContent).toContain("first")
  await render([
    ...prior,
    launch({
      status: "done",
      result: snapshot(),
      commandLive: snapshot("completed", "first\nlast\n", 0),
    }),
  ])
  expect(container.querySelector('[data-slot="active-command"]')).toBeNull()
  expect(triggers()[0]).toBe(group)
  expect(group.textContent).toContain("3 tool uses")
  expect(group.getAttribute("aria-expanded")).toBe("false")
  await act(async () => group.click())
  const command = triggers().find((t) =>
    t.textContent?.includes("Checking project")
  )!
  expect(command.getAttribute("aria-expanded")).toBe("false")
  await act(async () => command.click())
  expect(container.textContent).toContain("first\nlast\n")
})

it("preserves an expanded preceding group and its failure summary", async () => {
  const prior = [call("one"), call("two")]
  await render([...prior, launch({ commandLive: snapshot() })])
  await act(async () => triggers()[0].click())
  await render([
    ...prior,
    launch({ status: "done", commandLive: snapshot("completed", "failed", 2) }),
  ])
  expect(triggers()[0].getAttribute("aria-expanded")).toBe("true")
  expect(triggers()[0].textContent).toContain("1 failed")
})

it("does not extract historical running snapshots or approval waits", async () => {
  await render([launch({ status: "done", result: snapshot() })])
  expect(container.querySelector('[data-slot="active-command"]')).toBeNull()
  await render([
    launch({
      approval: {
        requestId: "r",
        status: "pending",
        reason: "gate",
        summary: "command",
      },
    }),
  ])
  expect(container.querySelector('[data-slot="active-command"]')).toBeNull()
  expect(container.textContent).toContain("Awaiting approval")
})

it("keeps artifact boundaries and does not duplicate launch calls", async () => {
  const chart = call("chart", {
    name: "present_chart",
    artifact: { artifactId: "chart", revision: 1 } as ToolUse["artifact"],
  })
  const command = launch({ commandLive: snapshot() })
  await render([call("before"), chart, command, command])
  expect(
    container.querySelectorAll('[data-slot="active-command"]')
  ).toHaveLength(1)
  const artifact = container.querySelector("figure")!
  expect(
    artifact.compareDocumentPosition(
      container.querySelector('[data-slot="active-command"]')!
    ) & Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy()
  await render([
    call("before"),
    chart,
    launch({ status: "done", commandLive: snapshot("completed", "last", 0) }),
  ])
  expect(triggers()[0].textContent).toContain("2 tool uses")
  expect(container.querySelectorAll("figure")).toHaveLength(1)
})

it("moves focus to the local disclosure when a focused terminal folds, without stealing other focus", async () => {
  const prior = [call("one"), call("two")]
  await render([...prior, launch({ commandLive: snapshot() })])
  container
    .querySelector<HTMLPreElement>('[data-slot="active-command"] pre')!
    .focus()
  await render([
    ...prior,
    launch({
      status: "done",
      commandLive: snapshot("terminated", "last", null),
    }),
  ])
  expect(document.activeElement).toBe(triggers()[0])
  const composer = document.createElement("input")
  document.body.append(composer)
  try {
    await render([...prior, launch({ commandLive: snapshot() })])
    composer.focus()
    await render([
      ...prior,
      launch({
        status: "done",
        commandLive: snapshot("timed_out", "last", null),
      }),
    ])
    expect(document.activeElement).toBe(composer)
  } finally {
    composer.remove()
  }
})

it("keeps concurrent terminals distinct and folds only the completed launch", async () => {
  const first = launch({ commandLive: snapshot() })
  const second = launch({
    id: "second",
    label: "Second command",
    commandLive: snapshot().replace('"s"', '"s2"'),
  })
  const before = [call("one"), call("two")]
  await render([...before, first, call("between"), second])
  expect(
    container.querySelectorAll('[data-slot="active-command"]')
  ).toHaveLength(2)
  const secondSurface = container.querySelectorAll(
    '[data-slot="active-command"]'
  )[1]
  await render([
    ...before,
    { ...first, status: "done", commandLive: snapshot("completed", "last", 0) },
    call("between"),
    second,
  ])
  expect(
    container.querySelectorAll('[data-slot="active-command"]')
  ).toHaveLength(1)
  expect(container.querySelector('[data-slot="active-command"]')).toBe(
    secondSurface
  )
  expect(triggers()[0].textContent).toContain("4 tool uses")
})
