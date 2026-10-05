import { describe, expect, it } from "vitest"
import type { Feature, Milestone, UserStory } from "../db/types"
import {
  renderConflictObjective,
  renderIntentChain,
  renderUserStoryObjective,
} from "./user-story-objective"

const feature = {
  name: "Billing",
  intent: "Bill customers",
  definitionOfDone: "",
} as Feature
const milestone = {
  name: "Invoices",
  outcome: "Invoices exist",
  definitionOfDone: "",
} as Milestone
function story(spec: Partial<UserStory["spec"]>): UserStory {
  return {
    key: "export",
    title: "Export invoices",
    spec: {
      story: null,
      goal: "",
      acceptance: [],
      outOfScope: [],
      touchHints: [],
      notes: "",
      ...spec,
    },
  } as UserStory
}

describe("user story objective", () => {
  it("renders the story above the goal and in the intent chain", () => {
    const userStory = story({
      story: {
        asA: "billing admin",
        iWant: "to export invoices",
        soThat: "I can send them",
      },
      goal: "Add a PDF export endpoint.",
      acceptance: [
        "Given an invoice, when it is exported, then a PDF is returned",
      ],
    })
    const text = renderUserStoryObjective({ feature, milestone, userStory })
    const story_ =
      "As a billing admin, I want to export invoices, so that I can send them."
    expect(text).toContain(`## Story\n${story_}`)
    expect(text.indexOf("## Story")).toBeLessThan(text.indexOf("## Goal"))
    expect(text).toContain(
      "- **AC-1**: Given an invoice, when it is exported, then a PDF is returned"
    )
    expect(renderIntentChain({ feature, milestone, userStory })).toContain(
      `  Story: ${story_}`
    )
  })

  it("leaves the story out for technical work", () => {
    const text = renderUserStoryObjective({
      feature,
      milestone,
      userStory: story({ goal: "Migrate" }),
    })
    expect(text).not.toContain("## Story")
    expect(text).toContain("## Goal\nMigrate")
  })
})

describe("renderConflictObjective", () => {
  const input = {
    feature,
    milestone,
    userStory: story({ goal: "Add a PDF export endpoint." }),
    integrationBranch: "mc/billing/m1/integration",
    userStoryBranch: "mc/billing/m1/userStories/a-1",
    files: ["src/app.py", ".code-index/symbols.jsonl"],
  }

  it("tells the integrator to regenerate the workspace's generated files", () => {
    const text = renderConflictObjective({
      ...input,
      generatedFiles: [
        {
          paths: [".code-index/**"],
          command: "codex-agentic-os index pre-commit",
        },
      ],
    })
    expect(text).toContain("## Generated files")
    expect(text).toContain(
      "`.code-index/**`: `codex-agentic-os index pre-commit`"
    )
  })

  it("says nothing about generated files when the workspace declares none", () => {
    expect(renderConflictObjective(input)).not.toContain("## Generated files")
  })
})
