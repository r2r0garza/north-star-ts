// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { WorkflowLibrary } from "./workflow-library"
import { EXAMPLE_WORKFLOWS } from "../../../main/db/workflow-schema"

let container: HTMLDivElement
let root: Root
let props: Parameters<typeof WorkflowLibrary>[0]
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  props = {
    workflows: structuredClone(EXAMPLE_WORKFLOWS),
    loaded: true,
    loading: false,
    error: false,
    creating: false,
    query: "",
    onQueryChange: vi.fn(),
    onRetry: vi.fn(),
    onCreate: vi.fn(),
    onImport: vi.fn(),
    onEdit: vi.fn(),
    onRun: vi.fn(),
    onExport: vi.fn(),
    onDelete: vi.fn(),
  }
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
async function render() {
  await act(async () => root.render(<WorkflowLibrary {...props} />))
}
function button(text: string) {
  return Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === text
  )!
}

it("searches names, descriptions, and step titles ignoring case and outer whitespace", async () => {
  for (const query of [
    " CODE REVIEW ",
    "IDENTIFY RISKS",
    "supporting evidence",
    "summarize findings",
  ]) {
    props.query = query
    await render()
    const cards = container.querySelectorAll('[data-slot="card"]')
    expect(cards).toHaveLength(query === "supporting evidence" ? 0 : 1)
    if (cards.length) expect(cards[0].textContent).toContain("Code review")
  }
  props.query = "readiness"
  await render()
  expect(container.textContent).toContain("1 of 3 workflows")
  expect(container.querySelector('[data-slot="card"]')?.textContent).toContain(
    "Release preparation"
  )
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Clear search"]')!
      .click()
  )
  expect(props.onQueryChange).toHaveBeenCalledWith("")
})

it("shows distinct loading, error, empty and no-match states", async () => {
  props.loaded = false
  await render()
  expect(container.textContent).toContain("Loading workflows…")
  props.error = true
  await render()
  await act(async () => button("Retry").click())
  expect(props.onRetry).toHaveBeenCalledOnce()
  props.error = false
  props.loaded = true
  props.workflows = []
  await render()
  expect(container.textContent).toContain("No workflows yet")
  expect(
    Array.from(container.querySelectorAll("button")).filter((b) =>
      b.textContent?.includes("New workflow")
    )
  ).toHaveLength(1)
  props.workflows = structuredClone(EXAMPLE_WORKFLOWS)
  props.query = "nothing matches"
  await render()
  expect(container.textContent).toContain("No matching workflows")
  expect(container.textContent).toContain("0 of 3 workflows")
})

it("previews at most three ordered steps and handles blank content and zero steps", async () => {
  props.workflows = [
    { ...EXAMPLE_WORKFLOWS[0], name: " ", description: "", steps: [] },
  ]
  await render()
  expect(container.textContent).toContain("Untitled workflow")
  expect(container.textContent).toContain("No description yet.")
  expect(container.textContent).toContain("No steps yet")
  expect(button("Run workflow").disabled).toBe(true)
  await act(async () => button("Edit").click())
  expect(props.onEdit).toHaveBeenCalledWith(props.workflows[0])
  props.workflows[0].steps = Array.from({ length: 5 }, (_, i) => ({
    id: String(i),
    title: i ? `Step ${i}` : "",
    instructions: "Work",
  }))
  await render()
  expect(container.querySelectorAll("ol li")).toHaveLength(3)
  expect(container.textContent).toContain("Untitled step")
  expect(container.textContent).toContain("+ 2 more steps")
  expect(button("Run workflow").disabled).toBe(false)
  await act(async () => button("Run workflow").click())
  expect(props.onRun).toHaveBeenCalledWith(props.workflows[0])
  props.workflows[0].steps = props.workflows[0].steps.slice(0, 1)
  await render()
  expect(container.textContent).toContain("1 step")
  expect(container.textContent).not.toContain("more steps")
})

it("exports through the portaled action menu without editing or running", async () => {
  await render()
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Workflow actions: Code review"]'
      )!
      .dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, button: 0 })
      )
  )
  const menu = document.querySelector('[role="menu"]')!
  expect(menu).not.toBeNull()
  await act(async () =>
    Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find((item) => item.textContent === "Export")!
      .click()
  )
  expect(props.onExport).toHaveBeenCalledWith(props.workflows[0])
  expect(props.onRun).not.toHaveBeenCalled()
  expect(props.onEdit).not.toHaveBeenCalled()
})
