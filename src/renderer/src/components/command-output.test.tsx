// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { CommandOutput } from "./command-output"
import { ToolGroup } from "./tool-group"
import type { ToolUse } from "@/lib/timeline"
let container: HTMLDivElement
let root: Root
const raw = (fields = {}) =>
  JSON.stringify({
    status: "completed",
    exitCode: 0,
    signal: null,
    output: "",
    ...fields,
  })
const call = (fields: Partial<ToolUse> = {}): ToolUse => ({
  id: "launch",
  name: "exec_command",
  label: "Checking project",
  rawArgs: '{ "command": " echo <hello> " }',
  args: { command: " echo <hello> " },
  status: "done",
  result: raw(),
  ...fields,
})
const render = async (calls: ToolUse[]) =>
  act(async () => root.render(<ToolGroup calls={calls} />))
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
it("separates contextual titles, exact command, empty output and original details", async () => {
  await render([call()])
  expect(triggers()[0].textContent).toContain("Checking project")
  expect(triggers()[0].textContent).not.toContain("echo")
  expect(triggers()[0].getAttribute("aria-expanded")).toBe("false")
  await act(async () => triggers()[0].click())
  expect(
    container.querySelector('[data-slot="code-block-code"]')?.textContent
  ).toBe(" echo <hello> ")
  expect(container.querySelector("hello")).toBeNull()
  expect(container.textContent).toContain("No output in this snapshot")
  expect(container.querySelector("details pre")?.textContent).toBe(
    call().rawArgs
  )
  expect(
    triggers()[0].querySelector('[data-slot="code-block-copy-button"]')
  ).toBeNull()
})
it("copies only displayed text with UI clipping separate from source omissions", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  })
  await render([
    call({
      result: raw({
        output: "x".repeat(9000),
        droppedBytes: 10,
        omittedBytes: 20,
        truncated: true,
      }),
    }),
  ])
  await act(async () => triggers()[0].click())
  const copy = container.querySelector<HTMLButtonElement>(
    '[aria-label="Copy displayed output"]'
  )!
  await act(async () => copy.click())
  expect(writeText).toHaveBeenCalledWith(
    "x".repeat(4000) + "\n…[UI clipped at 4,000 characters]"
  )
  expect(container.textContent).toContain("10 bytes dropped")
  expect(container.textContent).toContain("20 bytes omitted")
  expect(
    container.querySelectorAll('[data-slot="code-block-content"]')[1].className
  ).toContain("max-h-64")
})
it("does not claim a returned running session is done and preserves open state on completion snapshots", async () => {
  await render([
    call({
      result: raw({ status: "running", exitCode: null, sessionId: "s" }),
    }),
  ])
  expect(triggers()[0].textContent).toContain("Running when reported")
  expect(triggers()[0].querySelector(".lucide-check")).toBeNull()
  expect(triggers()[0].querySelector('[data-status="running"]')).toBeNull()
  await act(async () => triggers()[0].click())
  await render([call({ result: raw({ sessionId: "s", exitCode: 3 }) })])
  expect(triggers()[0].getAttribute("aria-expanded")).toBe("true")
  expect(triggers()[0].textContent).toContain("Exited with code 3")
  expect(triggers()[0].querySelector('[data-status="error"]')).not.toBeNull()
})
it("reflects process failure in group counts and retains pending and denied approval", async () => {
  await render([call({ result: raw({ exitCode: 1 }) }), call({ id: "other" })])
  expect(triggers()[0].textContent).toContain("1 failed")
  for (const status of ["pending", "denied"] as const) {
    await render([
      call({
        status: "running",
        result: undefined,
        approval: {
          requestId: "a",
          summary: "command",
          reason: "gate",
          status,
        },
      }),
    ])
    expect(triggers()[0].textContent).toContain(
      status === "pending" ? "Awaiting approval" : "Approval denied"
    )
  }
})
it("bounds completion entries and expands already available events without discarding invalid entries", async () => {
  const completions = Array.from({ length: 8 }, (_, index) =>
    index === 1
      ? null
      : JSON.parse(
          raw({
            eventId: `e${index}`,
            sessionId: `s${index}`,
            runId: "r",
            output: `out${index}`,
          })
        )
  )
  await act(async () =>
    root.render(
      <CommandOutput
        name="wait_for_events"
        args={null}
        rawArgs="{}"
        result={JSON.stringify({ status: "completed", completions })}
      />
    )
  )
  expect(container.querySelectorAll('[data-slot="code-block"]')).toHaveLength(4)
  expect(container.textContent).toContain("unsupported or missing entry")
  const expand = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Show all")
  )!
  await act(async () => expand.click())
  expect(container.querySelectorAll('[data-slot="code-block"]')).toHaveLength(7)
})

it("updates output in the same open block and retains the final failure without snapshot contradictions", async () => {
  const original = raw({ status: "running", exitCode: null, sessionId: "s" })
  await render([call({ result: original, commandLive: original })])
  await act(async () => triggers()[0].click())
  expect(container.textContent).toContain("Waiting for output")
  await render([
    call({
      result: original,
      commandLive: raw({
        status: "running",
        exitCode: null,
        sessionId: "s",
        output: "first\n",
      }),
    }),
  ])
  expect(triggers()[0].getAttribute("aria-expanded")).toBe("true")
  expect(
    container.querySelectorAll('[data-slot="code-block-code"]')[1].textContent
  ).toBe("first\n")
  await render([
    call({
      result: original,
      commandLive: raw({
        sessionId: "s",
        exitCode: 2,
        output: "first\nlast\n",
      }),
    }),
  ])
  expect(triggers()[0].textContent).toContain("Exited with code 2")
  expect(
    container.querySelectorAll('[data-slot="code-block-code"]')[1].textContent
  ).toBe("first\nlast\n")
  expect(container.textContent).not.toContain(
    "Final outcome unavailable in this snapshot"
  )
  expect(container.querySelectorAll("details pre")[1].textContent).toBe(
    original
  )
})

it("replaces an earlier empty snapshot with the final session output", async () => {
  await render([
    call({
      result: raw({ status: "running", exitCode: null, sessionId: "s" }),
      commandOutcome: {
        status: "completed",
        exitCode: 0,
        signal: null,
        sessionId: "s",
        output: "final output",
      },
    }),
  ])
  await act(async () => triggers()[0].click())
  expect(
    container.querySelectorAll('[data-slot="code-block-code"]')[1].textContent
  ).toBe("final output")
  expect(container.textContent).not.toContain("original snapshot")
  expect(container.textContent).not.toContain("No output in this snapshot")
})

const renderOutput = async (output: string, status = "running") =>
  act(async () =>
    root.render(
      <CommandOutput
        name="exec_command"
        args={{ command: "echo output" }}
        rawArgs="{}"
        live={status === "running"}
        result={raw({ output, status, sessionId: "s" })}
      />
    )
  )
const outputPanel = () =>
  container.querySelectorAll<HTMLPreElement>(
    '[data-slot="code-block-content"]'
  )[1]

it("opens output at the bottom without scrolling the command", async () => {
  const height = vi
    .spyOn(HTMLElement.prototype, "scrollHeight", "get")
    .mockReturnValue(800)
  try {
    await renderOutput("first\nlast\n")
    expect(outputPanel().scrollTop).toBe(800)
    expect(
      container.querySelector<HTMLPreElement>(
        '[data-slot="code-block-content"]'
      )!.scrollTop
    ).toBe(0)
  } finally {
    height.mockRestore()
  }
})

it("follows appended output through the final completion update", async () => {
  await renderOutput("first\n")
  const panel = outputPanel()
  let height = 800
  Object.defineProperties(panel, {
    scrollHeight: { get: () => height },
    clientHeight: { value: 256 },
  })
  panel.scrollTop = 544
  await act(async () => panel.dispatchEvent(new Event("scroll")))
  height = 1000
  await renderOutput("first\nsecond\n")
  expect(outputPanel()).toBe(panel)
  expect(panel.scrollTop).toBe(1000)
  height = 1200
  await renderOutput("first\nsecond\nlast\n", "completed")
  expect(panel.scrollTop).toBe(1200)
})

it("preserves manual scrollback and resumes following near the bottom", async () => {
  await renderOutput("first\n")
  const panel = outputPanel()
  let height = 800
  Object.defineProperties(panel, {
    scrollHeight: { get: () => height },
    clientHeight: { value: 256 },
  })
  panel.scrollTop = 100
  await act(async () => panel.dispatchEvent(new Event("scroll")))
  height = 1000
  await renderOutput("first\nsecond\n")
  expect(panel.scrollTop).toBe(100)
  panel.scrollTop = 730
  await act(async () => panel.dispatchEvent(new Event("scroll")))
  height = 1200
  await renderOutput("first\nsecond\nthird\n")
  expect(panel.scrollTop).toBe(1200)
  panel.scrollTop = 100
  await act(async () => panel.dispatchEvent(new Event("scroll")))
  height = 1400
  await renderOutput("first\nsecond\nthird\nlast\n", "completed")
  expect(panel.scrollTop).toBe(100)
})
