import { describe, expect, it } from "vitest"
import type { WorkflowDefinition } from "../shared/workflows"
import { serializeWorkflowExport } from "./workflow-export"

describe("portable workflow export", () => {
  it("omits local selections while preserving portable content and the saved definition", () => {
    const source: WorkflowDefinition = {
      id: "workflow",
      name: "Review",
      description: "Review changes",
      defaultObjective: "Find defects",
      viewInConversationSidebar: false,
      steps: [
        {
          id: "second",
          title: "Inspect",
          instructions: "Read the diff",
          accountId: "private-account",
          modelId: "private-model",
          agentName: "private-agent",
        },
        {
          id: "first",
          title: "Report",
          instructions: "Summarize findings",
          accountId: null,
          modelId: null,
          agentName: null,
        },
      ],
    }
    const snapshot = structuredClone(source)
    const expected = {
      id: source.id,
      name: source.name,
      description: source.description,
      defaultObjective: source.defaultObjective,
      viewInConversationSidebar: false,
      steps: [
        { id: "second", title: "Inspect", instructions: "Read the diff" },
        { id: "first", title: "Report", instructions: "Summarize findings" },
      ],
    }
    const serialized = serializeWorkflowExport(source)
    expect(serialized).toBe(JSON.stringify(expected, null, 2))
    expect(source).toEqual(snapshot)
    for (const step of JSON.parse(serialized).steps) {
      expect(step).not.toHaveProperty("accountId")
      expect(step).not.toHaveProperty("modelId")
      expect(step).not.toHaveProperty("agentName")
    }
  })

  it("keeps worker and validator effort levels", () => {
    const source: WorkflowDefinition = {
      id: "effort",
      name: "Effort",
      description: "",
      defaultObjective: "",
      steps: [
        {
          id: "one",
          title: "One",
          instructions: "Do it",
          modelId: "private-model",
          effort: "low",
          validatorEffort: "high",
        },
      ],
    }
    expect(JSON.parse(serializeWorkflowExport(source)).steps[0]).toEqual({
      id: "one",
      title: "One",
      instructions: "Do it",
      effort: "low",
      validatorEffort: "high",
    })
  })

  it("supports definitions without the optional sidebar flag or any steps", () => {
    const source: WorkflowDefinition = {
      id: "empty",
      name: "Empty",
      description: "",
      defaultObjective: "",
      steps: [],
    }
    expect(JSON.parse(serializeWorkflowExport(source))).toEqual(source)
  })
})
