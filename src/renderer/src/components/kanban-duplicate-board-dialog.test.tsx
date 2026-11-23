// @vitest-environment happy-dom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { DuplicateBoardDialog } from "./kanban-duplicate-board-dialog"

it("validates the name, supports both intake choices, and reports save failures", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  const duplicate = vi
    .fn()
    .mockResolvedValueOnce({ ok: false, reason: "Cannot save" })
    .mockResolvedValue({ ok: true, boardId: "copy" })
  Object.assign(window, { cowork: { kanban: { duplicate } } })
  const onEdit = vi.fn(),
    onCreated = vi.fn(),
    onOpenChange = vi.fn()
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  const click = async (text: string) =>
    act(async () => {
      ;[...document.querySelectorAll("button")]
        .find((b) => b.textContent === text)!
        .click()
    })
  const fill = async (value: string) =>
    act(async () => {
      const input = document.getElementById("duplicate-name")!
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )!.set!.call(input, value)
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
  try {
    await act(async () =>
      root.render(
        <DuplicateBoardDialog
          boardId="original"
          initialName="Team - Copy 3"
          onEdit={onEdit}
          onCreated={onCreated}
          onOpenChange={onOpenChange}
        />
      )
    )
    expect(
      (document.getElementById("duplicate-name") as HTMLInputElement).value
    ).toBe("Team - Copy 3")
    await fill(" ")
    await click("Keep intake and duplicate")
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Enter a name"
    )
    expect(duplicate).not.toHaveBeenCalled()
    await fill("My copy")
    await click("Edit intake settings")
    expect(onEdit).toHaveBeenCalledWith("My copy")
    expect(duplicate).not.toHaveBeenCalled()
    await click("Keep intake and duplicate")
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "Cannot save"
    )
    expect(onCreated).not.toHaveBeenCalled()
    await click("Keep intake and duplicate")
    expect(duplicate).toHaveBeenLastCalledWith("original", "My copy")
    expect(onCreated).toHaveBeenCalledWith("copy")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})
