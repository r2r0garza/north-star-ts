// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { NewBoardDialog } from "./kanban-new-board-dialog"

let root: Root
let container: HTMLDivElement
const create = vi.fn(async () => ({ ok: true, boardId: "new-board" }))
const testDraft = vi.fn(async () => ({ ok: true, count: 0, items: [] }))
const onCreated = vi.fn()
const onOpenChange = vi.fn()
const click = async (name: string) =>
  act(async () => {
    const button = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === name)!
    button.click()
  })
const choose = async (id: string, label: string) => {
  await act(async () => {
    const trigger = document.getElementById(id)!
    trigger.focus()
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      })
    )
  })
  const popup = document.querySelector('[data-slot="select-content"]')!
  expect(popup).not.toBeNull()
  expect(popup.closest('[role="dialog"]')).toBeNull()
  await act(async () => {
    const option = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((option) => option.textContent === label)!
    expect(option).toBeDefined()
    option.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))
    option.click()
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(document.activeElement?.id).toBe(id)
}
const fill = async (id: string, value: string) =>
  act(async () => {
    const input = document.getElementById(id)!
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )!.set!.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
beforeEach(async () => {
  vi.clearAllMocks()
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  Object.assign(window, { cowork: { kanban: { create, testDraft } } })
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      <NewBoardDialog open onOpenChange={onOpenChange} onCreated={onCreated} />
    )
  )
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

it("renders shared dropdowns with the original defaults and creates the same GitHub draft", async () => {
  expect(document.querySelector('[data-slot="native-select"]')).toBeNull()
  expect(
    document.querySelectorAll('[data-slot="select-trigger"]')
  ).toHaveLength(3)
  expect(document.getElementById("nb-tracker")?.textContent).toContain("GitHub")
  expect(document.getElementById("nb-match")?.textContent).toContain("any")
  expect(document.getElementById("nb-assignee")?.textContent).toContain("me")
  await fill("nb-name", "My board")
  await fill("nb-repo", "owner/repo")
  await click("Create board")
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      name: "My board",
      target: { tracker: "github", repo: "owner/repo" },
      filter: expect.objectContaining({
        match: "any",
        assignee: { mode: "me" },
      }),
    })
  )
  expect(onCreated).toHaveBeenCalledWith("new-board")
  expect(onOpenChange).toHaveBeenCalledWith(false)
})

it("changes all dropdowns, clears the tracker preview, and submits Azure selections", async () => {
  await click("Test")
  expect(document.body.textContent).toContain("0 matching items")
  await choose("nb-tracker", "Azure DevOps")
  expect(document.body.textContent).not.toContain("0 matching items")
  expect(document.getElementById("nb-repo")).toBeNull()
  await fill("nb-org", "dev.azure.com/example")
  await fill("nb-project", "Example")
  await choose("nb-match", "all")
  await choose("nb-assignee", "a person")
  expect(document.querySelector('label[for="nb-user"]')?.textContent).toBe(
    "Email"
  )
  await fill("nb-user", "person@example.com")
  expect(onOpenChange).not.toHaveBeenCalled()
  await click("Test")
  const expected = expect.objectContaining({
    target: {
      tracker: "ado",
      org: "dev.azure.com/example",
      project: "Example",
    },
    filter: expect.objectContaining({
      match: "all",
      assignee: { mode: "user", user: "person@example.com" },
    }),
  })
  expect(testDraft).toHaveBeenLastCalledWith(expected)
  await click("Create board")
  expect(create).toHaveBeenCalledWith(expected)
})

it("retains person text across assignee and tracker changes without leaking it into anyone mode", async () => {
  await choose("nb-assignee", "a person")
  await fill("nb-user", "person")
  await choose("nb-tracker", "Azure DevOps")
  expect((document.getElementById("nb-user") as HTMLInputElement).value).toBe(
    "person"
  )
  await choose("nb-assignee", "anyone")
  expect(document.getElementById("nb-user")).toBeNull()
  await choose("nb-tracker", "GitHub")
  await click("Create board")
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      target: { tracker: "github", repo: "" },
      filter: expect.objectContaining({ assignee: { mode: "anyone" } }),
    })
  )
})
