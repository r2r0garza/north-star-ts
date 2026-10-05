import { describe, expect, it } from "vitest"
import { formatStory, normalizeStory } from "./story"
import { parsePlanChange } from "./plan-changes"

describe("user story narrative", () => {
  it("normalizes the stored and the agent shapes, and drops an empty story", () => {
    expect(
      normalizeStory({ asA: " admin ", iWant: "export", soThat: "" })
    ).toEqual({
      asA: "admin",
      iWant: "export",
      soThat: "",
    })
    expect(
      normalizeStory({ as_a: "admin", i_want: "export", so_that: "share" })
    ).toEqual({
      asA: "admin",
      iWant: "export",
      soThat: "share",
    })
    expect(normalizeStory({ asA: " ", iWant: "", soThat: "" })).toBeNull()
    expect(normalizeStory("As a user")).toBeNull()
  })

  it("formats the familiar sentence", () => {
    expect(
      formatStory({
        asA: "billing admin",
        iWant: "to export invoices",
        soThat: "I can send them.",
      })
    ).toBe(
      "As a billing admin, I want to export invoices, so that I can send them."
    )
    expect(formatStory({ asA: "admin", iWant: "a report", soThat: "" })).toBe(
      "As an admin, I want a report."
    )
    expect(formatStory({ asA: "the owner", iWant: "", soThat: "" })).toBe(
      "As the owner."
    )
    expect(formatStory({ asA: "", iWant: "a report", soThat: "" })).toBe(
      "I want a report."
    )
  })

  it("carries a story through agent-supplied plan changes", () => {
    expect(
      parsePlanChange({
        op: "add_user_story",
        user_story: {
          title: "Export",
          story: { as_a: "admin", i_want: "to export", so_that: "I can share" },
          acceptance: ["Given an invoice, when I export it, then I get a PDF"],
        },
      })
    ).toEqual({
      op: "add_user_story",
      userStory: {
        title: "Export",
        story: { asA: "admin", iWant: "to export", soThat: "I can share" },
        acceptance: ["Given an invoice, when I export it, then I get a PDF"],
      },
    })
    // An edit can clear the story.
    expect(
      parsePlanChange({
        op: "edit_user_story",
        user_story: "export",
        patch: { story: null },
      })
    ).toEqual({
      op: "edit_user_story",
      userStory: "export",
      patch: { story: null },
    })
  })
})
