// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QuestionPanel } from "./question-panel"
import type { Question, QuestionAnswer } from "@/types"

// Renders the real panel in a DOM and drives it with actual window keydown
// events, so these exercise the same listener path the app uses. Focused on the
// keyboard flow: single-select Enter advances/submits; multi-select Enter only
// toggles and never advances.

let container: HTMLDivElement
let root: Root

function mount(
  questions: Question[],
  onSubmit: (a: QuestionAnswer[]) => void,
  collapsible = false
) {
  act(() => {
    root.render(
      <QuestionPanel
        questions={questions}
        onSubmit={onSubmit}
        collapsible={collapsible}
      />
    )
  })
}

// Dispatch a real keydown on window (bubbling + cancelable, like a browser).
function press(key: string, init: KeyboardEventInit = {}) {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...init,
      })
    )
  })
}

function optionButtons(): HTMLButtonElement[] {
  // The option rows are the buttons carrying the border/px-3 layout; simplest is
  // to read all buttons whose text matches known labels in the test.
  return Array.from(container.querySelectorAll("button"))
}

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

const single = (n: number): Question => ({
  question: `Q${n}?`,
  header: `Q${n}`,
  options: [{ label: `A${n}` }, { label: `B${n}` }, { label: `C${n}` }],
})

describe("QuestionPanel collapse flow", () => {
  it("is opt-in and starts expanded", () => {
    const onSubmit = vi.fn()
    mount([single(1)], onSubmit)
    expect(
      container.querySelector('[aria-label="Collapse questions"]')
    ).toBeNull()

    mount([single(1)], onSubmit, true)
    const collapse = container.querySelector<HTMLButtonElement>(
      '[aria-label="Collapse questions"]'
    )!
    expect(collapse.getAttribute("aria-expanded")).toBe("true")
    expect(container.textContent).toContain("Q1?")
  })

  it("preserves a free-form draft across collapse and expand", () => {
    const onSubmit = vi.fn()
    mount([single(1)], onSubmit, true)

    const other = optionButtons().find(
      (button) => button.textContent === "Other…"
    )!
    act(() => other.click())
    const textarea = container.querySelector("textarea")!
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )?.set?.call(textarea, "My custom answer")
      textarea.dispatchEvent(new Event("input", { bubbles: true }))
    })

    const collapse = container.querySelector<HTMLButtonElement>(
      '[aria-label="Collapse questions"]'
    )!
    act(() => collapse.click())
    expect(container.querySelector("textarea")).toBeNull()

    const expand = container.querySelector<HTMLButtonElement>(
      '[aria-label="Expand questions"]'
    )!
    expect(expand.getAttribute("aria-expanded")).toBe("false")
    act(() => expand.click())
    expect(
      container.querySelector<HTMLTextAreaElement>("textarea")?.value
    ).toBe("My custom answer")
  })

  it("does not handle hidden keyboard shortcuts while collapsed", () => {
    const onSubmit = vi.fn()
    mount([single(1)], onSubmit, true)

    const collapse = container.querySelector<HTMLButtonElement>(
      '[aria-label="Collapse questions"]'
    )!
    act(() => collapse.click())
    press("ArrowDown")
    press("Enter")
    expect(onSubmit).not.toHaveBeenCalled()

    const expand = container.querySelector<HTMLButtonElement>(
      '[aria-label="Expand questions"]'
    )!
    act(() => expand.click())
    press("Enter")
    expect(onSubmit).toHaveBeenCalledWith([{ selected: ["A1"] }])
  })

  it("collapses a presented plan and preserves refinement feedback", () => {
    const onSubmit = vi.fn()
    const plan: Question = {
      question: "",
      header: "Plan",
      body: "# Plan\n\nReview this implementation plan.",
      otherLabel: "Refine Plan…",
      options: [{ label: "Yes, approve" }],
    }
    mount([plan], onSubmit, true)

    expect(container.textContent).toContain("Review this implementation plan.")
    const refine = optionButtons().find(
      (button) => button.textContent === "Refine Plan…"
    )!
    act(() => refine.click())
    const textarea = container.querySelector("textarea")!
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )?.set?.call(textarea, "Keep the existing API.")
      textarea.dispatchEvent(new Event("input", { bubbles: true }))
    })

    const collapse = container.querySelector<HTMLButtonElement>(
      '[aria-label="Collapse plan"]'
    )!
    act(() => collapse.click())
    expect(container.textContent).not.toContain(
      "Review this implementation plan."
    )

    const expand = container.querySelector<HTMLButtonElement>(
      '[aria-label="Expand plan"]'
    )!
    act(() => expand.click())
    expect(container.textContent).toContain("Review this implementation plan.")
    expect(
      container.querySelector<HTMLTextAreaElement>("textarea")?.value
    ).toBe("Keep the existing API.")
  })
})

describe("QuestionPanel keyboard flow", () => {
  it("single-select, single question: Enter selects the active option and submits", () => {
    const onSubmit = vi.fn()
    mount([single(1)], onSubmit)

    // Active starts on the first option (A1). Down → B1. Enter selects + submits.
    press("ArrowDown")
    press("Enter")

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0][0]).toEqual([{ selected: ["B1"] }])
  })

  it("single-select, multiple questions: Enter selects then ADVANCES, submits on the last", () => {
    const onSubmit = vi.fn()
    mount([single(1), single(2)], onSubmit)

    // Q1: pick A1 (active is already on the first option) → should advance to Q2,
    // NOT submit yet.
    press("Enter")
    expect(onSubmit).not.toHaveBeenCalled()

    // Q2 should now be current: pick C2 (Down twice), Enter → submit both.
    press("ArrowDown")
    press("ArrowDown")
    press("Enter")

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0][0]).toEqual([
      { selected: ["A1"] },
      { selected: ["C2"] },
    ])
  })

  it("multi-select: Enter only toggles and never advances/submits, even on the last question", () => {
    const onSubmit = vi.fn()
    const q: Question = { ...single(1), multiSelect: true }
    mount([q], onSubmit)

    // Toggle A1 on, move to B1, toggle it on. Two Enters, still no submit.
    press("Enter") // toggles A1 (active = first)
    press("ArrowDown") // active → B1
    press("Enter") // toggles B1
    expect(onSubmit).not.toHaveBeenCalled()

    // The Submit button should be enabled (2 selected) and send both.
    const submitBtn = optionButtons().find((b) => b.textContent === "Submit")!
    expect(submitBtn.disabled).toBe(false)
    act(() => submitBtn.click())

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0][0]).toEqual([{ selected: ["A1", "B1"] }])
  })

  it("Left/Right move between questions (free jump), ungated by answered", () => {
    const onSubmit = vi.fn()
    mount([single(1), single(2)], onSubmit)

    // Jump Right to Q2 without answering Q1 — free jump, like clicking the tabs.
    press("ArrowRight")
    press("ArrowDown") // B2 active on Q2
    press("Enter") // Q2 is the last question → attempts submit…
    // …but Q1 is still unanswered, so submitSnapshot is gated: nothing sent.
    expect(onSubmit).not.toHaveBeenCalled()

    // Jump back Left to Q1 and answer it; now the (still-active) Q2 answer stands
    // and a final Enter on Q2 submits both.
    press("ArrowLeft")
    press("Enter") // Q1 → A1, advances to Q2
    press("Enter") // Q2 → B2 (already active), last question → submit
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0][0]).toEqual([
      { selected: ["A1"] },
      { selected: ["B2"] },
    ])
  })
})
