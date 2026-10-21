import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkflowDefinition } from "../../../shared/workflows"
import { serializeWorkflowExport } from "../../workflow-export"
import { importWorkflow } from "./workflows"

const { getDb, prepare, run } = vi.hoisted(() => {
  const run = vi.fn()
  const prepare = vi.fn(() => ({ run }))
  return { getDb: vi.fn(() => ({ prepare })), prepare, run }
})
vi.mock("../connection", () => ({ getDb }))

function definition(): WorkflowDefinition {
  return {
    id: "source",
    name: "Review",
    description: "Review changes",
    defaultObjective: "Find defects",
    viewInConversationSidebar: true,
    steps: [
      {
        id: "first",
        title: "Inspect",
        instructions: "Read the diff",
        accountId: "local-account",
        modelId: "local-model",
        agentName: "local-agent",
        skillName: "git-commit",
      },
      { id: "second", title: "Report", instructions: "Summarize findings" },
    ],
  }
}

beforeEach(() => vi.clearAllMocks())

describe("workflow import validation", () => {
  it("accepts valid validator settings and rejects invalid correction budgets", () => {
    const workflow = {
      id: "source", name: "Test", description: "", defaultObjective: "",
      steps: [{ id: "one", title: "One", instructions: "Do it", validateCompletion: true, maxCorrectionLoops: 2, validatorAccountId: "acct", validatorModelId: "model", validatorAgentName: "reviewer" }],
    }
    expect(importWorkflow(workflow).steps[0]).toMatchObject({
      validateCompletion: true, maxCorrectionLoops: 2, validatorModelId: "model", validatorAgentName: "reviewer",
    })
    expect(() => importWorkflow({ ...workflow, steps: [{ ...workflow.steps[0], maxCorrectionLoops: 11 }] })).toThrow("Invalid workflow")
  })

  it.each([
    [
      "missing step ID",
      () => {
        const source = definition()
        const { id: _id, ...step } = source.steps[0]
        return { ...source, steps: [step] }
      },
    ],
    [
      "empty step ID",
      () => {
        const source = definition()
        return { ...source, steps: [{ ...source.steps[0], id: "" }] }
      },
    ],
    [
      "duplicate step IDs",
      () => {
        const source = definition()
        return { ...source, steps: [source.steps[0], source.steps[0]] }
      },
    ],
    ["numeric workflow ID", () => ({ ...definition(), id: 123 })],
    [
      "invalid title",
      () => {
        const source = definition()
        return { ...source, steps: [{ ...source.steps[0], title: 123 }] }
      },
    ],
    ["unknown workflow field", () => ({ ...definition(), extra: true })],
    [
      "unknown step field",
      () => {
        const source = definition()
        return { ...source, steps: [{ ...source.steps[0], extra: true }] }
      },
    ],
  ])("rejects %s before accessing persistence", (_name, makeInput) => {
    expect(() => importWorkflow(makeInput())).toThrow("Invalid workflow")
    expect(getDb).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it("inserts a copy with fresh IDs while preserving legacy optional selections", () => {
    const source = definition()
    const snapshot = structuredClone(source)
    const imported = importWorkflow(source)

    expect(source).toEqual(snapshot)
    expect(imported.id).not.toBe(source.id)
    expect(
      new Set([imported.id, ...imported.steps.map((step) => step.id)]).size
    ).toBe(3)
    imported.steps.forEach((step, index) => {
      expect(step.id).not.toBe(source.steps[index].id)
      expect({ ...step, id: source.steps[index].id }).toEqual(
        source.steps[index]
      )
    })
    expect({ ...imported, id: source.id, steps: source.steps }).toEqual(source)
    expect(prepare).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("INSERT INTO workflows")
    )
    expect(run).toHaveBeenCalledExactlyOnceWith(
      imported.id,
      source.name,
      source.description,
      source.defaultObjective,
      1,
      JSON.stringify(imported.steps)
    )
  })

  it("imports portable exports without model, account, or agent overrides", () => {
    const exported = JSON.parse(serializeWorkflowExport(definition()))
    const imported = importWorkflow(exported)
    expect(imported.steps).toEqual([
      {
        id: expect.any(String),
        title: "Inspect",
        instructions: "Read the diff",
        skillName: "git-commit",
      },
      {
        id: expect.any(String),
        title: "Report",
        instructions: "Summarize findings",
      },
    ])
    expect(run).toHaveBeenCalledOnce()
  })
})

it.each([123, "", "/git-commit", "git-commit\ninjected"])(
  "rejects invalid skill assignment %j",
  (skillName) => {
    const source = definition()
    expect(() =>
      importWorkflow({ ...source, steps: [{ ...source.steps[0], skillName }] })
    ).toThrow("Invalid workflow")
    expect(getDb).not.toHaveBeenCalled()
  }
)

it("preserves assigned skills through portable export and import", () => {
  const imported = importWorkflow(
    JSON.parse(serializeWorkflowExport(definition()))
  )
  expect(imported.steps[0].skillName).toBe("git-commit")
  expect(imported.steps[1].skillName).toBeUndefined()
})
