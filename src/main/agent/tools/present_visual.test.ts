import { afterEach, expect, it, vi } from "vitest"
import { presentVisualTool } from "./present_visual"
const input = {
  title: "Summary",
  library: "north-star-static-v1",
  document: 'root = Text("Synthetic summary");',
  datasets: [],
}
afterEach(() => vi.unstubAllEnvs())
it("requires opt-in and durable runtime, rejects cancellation and stages only valid complete content", async () => {
  const emitArtifact = vi.fn()
  const ctx = {
    workspace: "",
    conversationId: "owned",
    invocationId: "call",
    emitArtifact,
  }
  vi.stubEnv("NORTH_STAR_OPENUI_SPIKE", "0")
  expect(await presentVisualTool.execute(input, ctx)).toContain(
    "ERROR[unavailable]"
  )
  vi.stubEnv("NORTH_STAR_OPENUI_SPIKE", "1")
  expect(await presentVisualTool.execute(input, { workspace: "" })).toContain(
    "ERROR[unavailable]"
  )
  expect(
    await presentVisualTool.execute(input, { ...ctx, planMode: true })
  ).toContain("ERROR[unavailable]")
  expect(
    await presentVisualTool.execute(input, {
      ...ctx,
      signal: AbortSignal.abort(),
    })
  ).toContain("ERROR[cancelled]")
  expect(
    await presentVisualTool.execute(
      { ...input, document: "root = Text(@Sum([1,2]));" },
      ctx
    )
  ).toContain("ERROR[bad_args]")
  expect(emitArtifact).not.toHaveBeenCalled()
  expect(
    await presentVisualTool.execute(
      { ...input, _activity: "Presenting summary" },
      ctx
    )
  ).toContain("awaiting durable")
  expect(emitArtifact).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "visual", library: "north-star-static-v1" })
  )
})

it("explains and recovers from the observed percent, bracket, terminator and Text-arity failures", async () => {
  vi.stubEnv("NORTH_STAR_OPENUI_SPIKE", "1")
  const emitArtifact = vi.fn()
  const ctx = {
    workspace: "",
    conversationId: "owned",
    invocationId: "call",
    emitArtifact,
  }
  const originalDocument =
    'root = Stack([Tabs([Tab("Overview", [Stack([Text("SYNTHETIC RESULTS — illustrative data only", "body"), Row([Card("Team Alpha", [Metric("Completion rate", 0.75, "percent"), Text("18 of 24 tasks completed", "muted")]), Card("Team Beta", [Metric("Completion rate", 0.5, "percent"), Text("15 of 30 tasks completed", "muted")])])])]), Tab("Evidence", [Stack([Text("SYNTHETIC RESULTS — illustrative data only", "body"), Chart("completion"), DataTable("tasks")])])])])'
  const chart = {
    kind: "chart",
    schemaVersion: 1,
    title: "Synthetic completion rates",
    chartKind: "bar",
    xKey: "team",
    numberFormat: "percent",
    unit: "completion rate",
    series: [{ key: "rate", label: "Completion rate" }],
    data: [
      { team: "Team Alpha", rate: 0.75 },
      { team: "Team Beta", rate: 0.5 },
    ],
  }
  const table = {
    kind: "table",
    schemaVersion: 1,
    title: "Synthetic task rates",
    columns: [
      { key: "team", label: "Team", valueType: "string" },
      {
        key: "rate",
        label: "Completion",
        valueType: "number",
        numberFormat: "percent",
      },
    ],
    data: chart.data,
  }
  const payload = {
    ...input,
    document: originalDocument,
    datasets: [
      { id: "completion", snapshot: chart },
      { id: "tasks", snapshot: table },
    ],
  }
  expect(await presentVisualTool.execute(payload, ctx)).toContain(
    "percent format only supports unit %"
  )
  const fixedData = {
    ...payload,
    datasets: [
      { id: "completion", snapshot: { ...chart, unit: "%" } },
      { id: "tasks", snapshot: table },
    ],
  }
  const brackets = await presentVisualTool.execute(fixedData, ctx)
  expect(brackets).toContain("Expected final ; at 462")
  expect(brackets).toContain("same Tabs array")
  expect(
    await presentVisualTool.execute(
      { ...fixedData, document: 'root = Text("Synthetic")' },
      ctx
    )
  ).toContain("end of document")
  expect(
    await presentVisualTool.execute(
      { ...fixedData, document: 'root = Text("Synthetic", "body");' },
      ctx
    )
  ).toContain("Text takes 1 arg(s), got 2")
  expect(emitArtifact).not.toHaveBeenCalled()
  const document =
    'root = Tabs([Tab("Overview",[Row([Card("Team Alpha",[Metric("Completion rate",0.75,"percent"),Text("18 of 24 tasks completed")]),Card("Team Beta",[Metric("Completion rate",0.5,"percent"),Text("15 of 30 tasks completed")])])]),Tab("Evidence",[Text("Synthetic results only"),Chart("completion"),DataTable("tasks")])]);'
  expect(
    await presentVisualTool.execute({ ...fixedData, document }, ctx)
  ).toContain("awaiting durable")
  expect(emitArtifact).toHaveBeenCalledOnce()
})

it("advertises exact document syntax and percent units beside the input fields", () => {
  const parameters = presentVisualTool.definition.function.parameters as {
    properties: {
      document: { description: string }
      datasets: { items: { properties: { snapshot: { description: string } } } }
    }
  }
  expect(parameters.properties.document.description).toContain(
    'Text("text") has no second role/style argument'
  )
  expect(parameters.properties.document.description).toContain("root = Tabs(")
  expect(
    parameters.properties.datasets.items.properties.snapshot.description
  ).toContain('omit unit or use "%" only')
})
