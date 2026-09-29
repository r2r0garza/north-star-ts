import { describe, expect, it } from "vitest"
import type { Feature, Milestone, UserStory } from "../db/types"
import {
  INTENT_CHAIN_MAX_CHARS,
  renderIntentChain,
  renderRefocus,
} from "./intent-chain"

const feature = {
  key: "billing",
  name: "v1.0 of billing",
  intent: "Customers can be invoiced.",
  definitionOfDone: "Invoices go out monthly.",
} as Feature
const milestone = {
  key: "m1",
  name: "Invoices",
  outcome: "Invoices exist.",
  definitionOfDone: "",
} as Milestone
function story(spec: Partial<UserStory["spec"]> = {}): UserStory {
  return {
    key: "invoice-model",
    title: "Invoice model",
    spec: {
      story: null,
      goal: "Add an invoice model.",
      acceptance: ["Has line items", "Totals are computed"],
      outOfScope: ["PDF rendering"],
      touchHints: [],
      notes: "",
      ...spec,
    },
  } as UserStory
}

describe("intent chain", () => {
  it("walks bottom-up from the user story to the feature", () => {
    const text = renderIntentChain({ feature, milestone, userStory: story() })
    const lines = text.split("\n")
    expect(lines[0]).toBe(
      'You are working on: user story invoice-model "Invoice model"'
    )
    expect(text).toContain(
      "  Acceptance: AC-1 Has line items; AC-2 Totals are computed"
    )
    expect(text).toContain("  OUT OF SCOPE: PDF rendering")
    expect(text.indexOf("which serves: milestone m1")).toBeLessThan(
      text.indexOf("which serves: feature billing")
    )
    expect(text).toContain(
      "Definition of done at your altitude: every acceptance criterion"
    )
  })

  it("uses the milestone's definition of done at milestone altitude", () => {
    const text = renderIntentChain({
      feature,
      milestone: { ...milestone, definitionOfDone: "All invoices reconcile." },
    })
    expect(text.split("\n")[0]).toBe(
      'You are working on: milestone m1 "Invoices" — Invoices exist.'
    )
    expect(text).toContain(
      "Definition of done at your altitude: All invoices reconcile."
    )
  })

  it("stays within its bound and keeps every criterion id when fields are huge", () => {
    const long = "x".repeat(5000)
    const userStory = story({
      goal: long,
      acceptance: Array.from({ length: 5 }, () => long),
      outOfScope: Array.from({ length: 30 }, () => long),
    })
    const chain = renderIntentChain({
      feature: { ...feature, intent: long, definitionOfDone: long },
      milestone: { ...milestone, outcome: long, definitionOfDone: long },
      userStory,
    })
    for (const id of ["AC-1", "AC-2", "AC-3", "AC-4", "AC-5"])
      expect(chain).toContain(id)
    const full = renderRefocus({
      chain,
      seat: { address: "builder@implementation", charter: long },
      lead: long,
    })
    expect(full.length).toBeLessThanOrEqual(INTENT_CHAIN_MAX_CHARS)
    expect(full).toContain("Your seat: builder@implementation")
    expect(full).toContain("propose_followup")
  })

  it("asks the question at the right altitude", () => {
    expect(
      renderRefocus({
        chain: renderIntentChain({ feature, milestone, userStory: story() }),
      })
    ).toContain("necessary for the acceptance criteria above?")
    expect(
      renderRefocus({ chain: renderIntentChain({ feature, milestone }) })
    ).toContain("necessary for the definition of done above?")
  })
})
