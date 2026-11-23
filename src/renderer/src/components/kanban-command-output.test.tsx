// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { KanbanCommandOutput } from "./kanban-command-output"
import { RunHistory } from "./kanban-screen"
import type { KanbanCard, KanbanCardRun } from "../../../shared/kanban"

let container: HTMLDivElement
let root: Root
const run = (id = "run", output = "first\n"): KanbanCardRun => ({
  id,
  kind: "command",
  cardId: "card",
  columnId: "column",
  columnName: "Build",
  taskId: "task",
  conversationId: null,
  status: "running",
  outcome: null,
  result: null,
  error: null,
  startedAt: 1,
  finishedAt: null,
  commandOutput: {
    runId: id,
    command: "echo '<script>not markup</script>'",
    cwd: "/workspace",
    status: "running",
    output,
    exitCode: null,
    signal: null,
    omittedBytes: 0,
  },
})

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it("shows literal copyable output, scroll following, omissions and truthful process exit independent of routing", async () => {
  const copy = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: copy },
  })
  let value = run()
  await act(async () => root.render(<KanbanCommandOutput run={value} />))
  expect(container.querySelector("script")).toBeNull()
  const pre = container.querySelectorAll<HTMLPreElement>("pre")[1]
  Object.defineProperties(pre, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { value: 100 },
  })
  pre.scrollTop = 100
  await act(async () => pre.dispatchEvent(new Event("scroll")))
  value = {
    ...value,
    commandOutput: { ...value.commandOutput!, output: "first\nsecond\n" },
  }
  await act(async () => root.render(<KanbanCommandOutput run={value} />))
  expect(pre.scrollTop).toBe(100)
  pre.scrollTop = 900
  await act(async () => pre.dispatchEvent(new Event("scroll")))
  value = {
    ...value,
    status: "completed",
    result: "routed failure",
    commandOutput: {
      ...value.commandOutput!,
      status: "exited",
      exitCode: 7,
      output: "first\nsecond\nfinal",
      omittedBytes: 12,
    },
  }
  await act(async () => root.render(<KanbanCommandOutput run={value} />))
  expect(pre.scrollTop).toBe(1000)
  expect(container.textContent).toContain("Exit: 7")
  expect(container.textContent).toContain("Older output omitted: 12 bytes")
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Copy displayed output"]')!
      .click()
  )
  expect(copy).toHaveBeenCalledWith("first\nsecond\nfinal")
})

it("identifies queued, empty running, stopped, timeout, startup failure and unavailable history", async () => {
  for (const [status, label] of [
    ["queued", "Queued"],
    ["running", "Waiting for output"],
    ["timed_out", "Timed out"],
    ["stopped", "Stopped"],
    ["failed", "failed to start"],
  ] as const) {
    const value = run("run", "")
    value.commandOutput!.status = status
    await act(async () => root.render(<KanbanCommandOutput run={value} />))
    expect(container.textContent).toContain(label)
  }
  await act(async () =>
    root.render(<KanbanCommandOutput run={{ ...run(), commandOutput: null }} />)
  )
  expect(container.textContent).toContain("Live output unavailable")
})

it("catches up and follows while open, stops polling on close, and ignores late responses after switching cards", async () => {
  vi.useFakeTimers()
  let current = run()
  let resolveOld: ((runs: KanbanCardRun[]) => void) | undefined
  const runs = vi.fn(async (id: string) =>
    id === "old"
      ? await new Promise<KanbanCardRun[]>((resolve) => {
          resolveOld = resolve
        })
      : [current]
  )
  vi.stubGlobal("cowork", undefined)
  Object.defineProperty(window, "cowork", {
    configurable: true,
    value: { kanban: { runs, actions: vi.fn(async () => []) } },
  })
  const card = (id: string) => ({ id, item: { id, title: id } }) as KanbanCard
  const show = (id: string | null) =>
    act(async () =>
      root.render(
        <RunHistory
          card={id ? card(id) : null}
          onClose={() => {}}
          onOpenConversation={() => {}}
        />
      )
    )
  await show("card")
  expect(document.body.textContent).toContain("first")
  current = run("run", "first\nsecond before exit")
  await act(async () => vi.advanceTimersByTimeAsync(250))
  expect(document.body.textContent).toContain("second before exit")
  await show(null)
  const calls = runs.mock.calls.length
  await act(async () => vi.advanceTimersByTimeAsync(1000))
  expect(runs.mock.calls.length).toBe(calls)
  await show("card")
  expect(document.body.textContent).toContain("second before exit")
  await show("old")
  current = run("new", "new card output")
  await show("new")
  await act(async () => resolveOld!([run("old", "wrong card output")]))
  expect(document.body.textContent).toContain("new card output")
  expect(document.body.textContent).not.toContain("wrong card output")
})
