import { describe, expect, it } from "vitest"
import {
  validateArtifactPresentation,
  validateArtifactSnapshot,
} from "./conversation-artifacts"
import { validateVisualSnapshot } from "./openui-visual"
import { comparisonChart } from "./openui-comparison.fixture"

export const visualInput = {
  title: "Synthetic mixed answer",
  library: "north-star-static-v1",
  document:
    'root = Stack([Text("Synthetic evidence"),Metric("Completion",0.75,"percent"),Chart("rates")]);',
  datasets: [{ id: "rates", snapshot: comparisonChart }],
}
describe("versioned static visual artifact", () => {
  it("round-trips canonical snapshots and revision input", () => {
    const snapshot = validateVisualSnapshot(visualInput)
    expect(
      validateArtifactSnapshot(JSON.parse(JSON.stringify(snapshot)))
    ).toEqual(snapshot)
    expect(
      validateArtifactPresentation(
        { ...visualInput, artifactId: "owned", expectedBaseRevision: 1 },
        "visual"
      )
    ).toMatchObject({ kind: "visual", artifactId: "owned" })
  })
  it.each([
    { library: "future" },
    { document: 'root = Chart("missing");' },
    { document: 'root = DataTable("rates");' },
    { document: "root = Text(123);" },
    { document: 'root = Text("kept", "dropped");' },
    { document: "root = Stack([null]);" },
    { document: 'root = Concept("compact");' },
    { document: 'root = Metric("x",null,"number");' },
    { document: 'root = Tabs([Text("x"),Text("y")]);' },
    { document: 'root = Tab("orphan",[]);' },
    {
      datasets: [
        { id: "rates", snapshot: comparisonChart },
        { id: "rates", snapshot: comparisonChart },
      ],
    },
    { recipe: { url: "https://example.com" } },
    { schemaVersion: 2 },
  ])("rejects invalid or unsupported content %j", (patch) => {
    expect(() => validateVisualSnapshot({ ...visualInput, ...patch })).toThrow()
  })
})
