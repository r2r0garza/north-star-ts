// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UiConceptPreview, conceptStateAfter } from "./ui-concept-preview"
import {
  ArtifactChoiceContext,
  ConversationArtifact,
} from "./conversation-artifact"
import {
  validateUiConceptSnapshot,
  type UiConceptScreens,
  type UiConceptSnapshot,
} from "../../../shared/conversation-artifacts"
import { conceptInput } from "../../../shared/ui-concept-artifacts.fixture"

// Single-concept fixtures always carry a tree.
const single = (input: unknown) =>
  validateUiConceptSnapshot(input) as UiConceptSnapshot & UiConceptScreens
const concept = single(conceptInput)
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe("UiConceptPreview", () => {
  it("renders semantic, labelled, non-operational controls", async () => {
    await act(async () => root.render(<UiConceptPreview concept={concept} />))
    expect(container.querySelector("h4")?.textContent).toBe("Notifications")
    expect(container.textContent).toContain("not your project's components")
    const labels = container.querySelectorAll("label")
    expect(labels.length).toBeGreaterThan(0)
    for (const label of labels)
      expect(container.querySelector(`[id="${label.htmlFor}"]`)).not.toBeNull()
    expect(container.querySelector("form")).toBeNull()
    for (const button of container.querySelectorAll("button:not([role])"))
      expect(button.getAttribute("type")).toBe("button")
    expect(container.querySelector('[role="tablist"]')).not.toBeNull()
    expect((container.querySelector("select") as HTMLSelectElement).value).toBe(
      "Weekly"
    )
  })

  it("keeps demo values when switching tabs", async () => {
    await act(async () => root.render(<UiConceptPreview concept={concept} />))
    const toggle = () =>
      container.querySelector('[role="switch"]') as HTMLButtonElement
    await act(() => toggle().click())
    expect(toggle().getAttribute("aria-checked")).toBe("false")
    const tabs = container.querySelectorAll('[role="tab"]')
    const select = (tab: Element) =>
      act(() => {
        tab.dispatchEvent(
          new MouseEvent("mousedown", { bubbles: true, button: 0 })
        )
      })
    await select(tabs[1])
    expect(tabs[1].getAttribute("aria-selected")).toBe("true")
    await select(tabs[0])
    expect(toggle().getAttribute("aria-checked")).toBe("false")
  })

  it("escapes markup and keeps keys away from app shortcuts except Escape", async () => {
    const onKey = vi.fn()
    window.addEventListener("keydown", onKey)
    await act(async () =>
      root.render(
        <UiConceptPreview
          concept={{
            tree: {
              type: "stack",
              children: [
                { type: "text", text: "<img src=x onerror=alert(1)>" },
                { type: "button", text: "Go" },
              ],
            },
          }}
        />
      )
    )
    expect(container.querySelector("img")).toBeNull()
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>")
    const button = container.querySelector("button")!
    button.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", bubbles: true })
    )
    expect(onKey).not.toHaveBeenCalled()
    button.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    )
    expect(onKey).toHaveBeenCalledTimes(1)
    window.removeEventListener("keydown", onKey)
  })

  it("moves only between declared states and resets demo state per screen", async () => {
    const flow = single({
      title: "List/detail",
      tree: {
        type: "stack",
        children: [
          {
            type: "field",
            label: "Search",
            control: { type: "input" },
          },
          { type: "button", text: "Open Ana", goTo: "detail" },
        ],
      },
      states: [
        {
          id: "detail",
          label: "Ana's conversation",
          tree: {
            type: "stack",
            children: [
              { type: "text", role: "heading", text: "Ana" },
              { type: "button", text: "Back", goTo: "initial" },
            ],
          },
        },
      ],
    })
    await act(async () => root.render(<UiConceptPreview concept={flow} />))
    const click = (label: string) =>
      act(() =>
        [...container.querySelectorAll("button")]
          .find((b) => b.textContent === label)!
          .click()
      )
    const input = () => container.querySelector("input") as HTMLInputElement
    input().value = "typed"
    expect(container.textContent).toContain("Preview state: Initial")
    await click("Open Ana")
    expect(container.querySelector("h4")?.textContent).toBe("Ana")
    expect(container.textContent).toContain("Preview state: Ana's conversation")
    await click("Back")
    expect(input().value).toBe("")
    await click("Open Ana")
    await click("Reset preview")
    expect(container.textContent).toContain("Preview state: Initial")
    expect(conceptStateAfter(flow, "initial", "nowhere")).toBe("initial")
    expect(conceptStateAfter(flow, "initial", undefined)).toBe("initial")
    expect(conceptStateAfter(flow, "detail", "initial")).toBe("initial")
  })

  it("applies scoped tokens and offers width presets only when asked", async () => {
    const styled = { ...concept, density: "compact", typeScale: "lg" } as const
    await act(async () => root.render(<UiConceptPreview concept={styled} />))
    const frame = () =>
      container.querySelector('[aria-label="UI concept preview"]')!
    expect(frame().className).toContain("[--spacing:0.2rem]")
    expect(frame().className).toContain("[--text-lg:1.25rem]")
    expect(container.querySelector('[aria-label="Preview width"]')).toBeNull()
    await act(async () =>
      root.render(<UiConceptPreview concept={styled} viewportPresets />)
    )
    const mobile = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Mobile"
    )!
    await act(() => mobile.click())
    expect(mobile.getAttribute("aria-pressed")).toBe("true")
    expect(frame().className).toContain("max-w-[375px]")
  })

  async function renderFigure(
    choose?: (choice: unknown) => void,
    snapshot: UiConceptSnapshot = concept
  ) {
    const reference = {
      schemaVersion: 1 as const,
      artifactId: "a",
      revision: 2,
      kind: "ui_concept" as const,
      title: concept.title,
      rowCount: 0,
    }
    const read = vi.fn().mockResolvedValue({
      artifact: {
        schemaVersion: 1,
        conversationId: "c",
        invocationId: "i",
        reference,
        snapshot,
      },
    })
    Object.defineProperty(window, "cowork", {
      configurable: true,
      value: { db: { artifacts: { read } } },
    })
    const figure = (
      <ConversationArtifact conversationId="c" reference={reference} />
    )
    await act(async () =>
      root.render(
        choose ? (
          <ArtifactChoiceContext.Provider value={choose}>
            {figure}
          </ArtifactChoiceContext.Provider>
        ) : (
          figure
        )
      )
    )
    return read
  }
  const useButton = () =>
    [...container.querySelectorAll("button")].find((b) =>
      /direction|Added to your message|^Use “/.test(b.textContent ?? "")
    )

  it("loads a saved concept through the shared figure with its revision", async () => {
    const read = await renderFigure()
    expect(read).toHaveBeenCalledWith("c", "a", 2)
    expect(container.querySelector("h3")?.textContent).toBe(concept.title)
    expect(container.textContent).toContain(concept.description)
    expect(container.textContent).toContain("Revision 2")
    expect(
      container.querySelector('[aria-label="UI concept preview"]')
    ).not.toBeNull()
    expect(container.textContent).toContain("Expand")
    // No composer provider (task/workflow readers): no feedback control.
    expect(useButton()).toBeUndefined()
  })

  it("hands the exact revision to the composer once", async () => {
    const choose = vi.fn()
    await renderFigure(choose)
    await act(() => useButton()!.click())
    await act(() => useButton()!.click())
    expect(choose).toHaveBeenCalledTimes(1)
    expect(choose).toHaveBeenCalledWith({ artifactId: "a", revision: 2 })
    expect(useButton()!.textContent).toBe("Added to your message")
  })

  it("switches alternatives in one figure and chooses the one shown", async () => {
    const ideas = validateUiConceptSnapshot({
      title: "Dashboard ideas",
      alternatives: [
        {
          id: "grid",
          label: "Card grid",
          description: "Metrics as cards",
          tree: {
            type: "stack",
            children: [
              { type: "text", role: "heading", text: "Grid layout" },
              {
                type: "field",
                label: "Filter",
                control: { type: "input" },
              },
            ],
          },
        },
        {
          id: "table",
          label: "Table first",
          tree: { type: "text", role: "heading", text: "Table layout" },
        },
      ],
    })
    const choose = vi.fn()
    await renderFigure(choose, ideas)
    const buttons = () => [...container.querySelectorAll("button")]
    const press = (label: string) =>
      act(() =>
        buttons()
          .find((b) => b.textContent === label)!
          .click()
      )
    expect(
      container.querySelectorAll('[aria-label="UI concept preview"]')
    ).toHaveLength(1)
    expect(container.querySelector("h4")?.textContent).toBe("Grid layout")
    expect(container.textContent).toContain("Metrics as cards")
    ;(container.querySelector("input") as HTMLInputElement).value = "typed"
    await press("Use “Card grid”")
    expect(choose).toHaveBeenLastCalledWith({
      artifactId: "a",
      revision: 2,
      alternative: { id: "grid", label: "Card grid" },
    })
    expect(useButton()?.textContent).toBe("Added to your message")
    await press("2. Table first")
    expect(container.querySelector("h4")?.textContent).toBe("Table layout")
    expect(
      buttons()
        .find((b) => b.textContent === "2. Table first")!
        .getAttribute("aria-pressed")
    ).toBe("true")
    await press("Use “Table first”")
    expect(choose).toHaveBeenLastCalledWith({
      artifactId: "a",
      revision: 2,
      alternative: { id: "table", label: "Table first" },
    })
    await press("1. Card grid")
    expect((container.querySelector("input") as HTMLInputElement).value).toBe(
      ""
    )
    expect(useButton()?.textContent).toBe("Use “Card grid”")
  })
})
