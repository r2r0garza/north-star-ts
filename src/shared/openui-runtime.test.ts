import { describe, expect, it } from "vitest"
import { prepareOpenui } from "../../scripts/fixtures/openui-library"

const valid = [
  'root = Row([Metric("Completion",0.75,"percent"),Metric("Observed",2,"integer")]);',
  'root = Stack([Text("Synthetic"),Chart("completion"),DataTable("supporting")]);',
  'root = Tabs([Tab("First",[Concept("compact")]),Tab("Second",[Concept("card")])]);',
  'root = Stack([Chart("large"),DataTable("large-table"),DataTable("empty")]);',
]
describe("OpenUI complete static runtime admission", () => {
  it.each(valid)("accepts complete bounded fixtures: %s", (source) => {
    expect(prepareOpenui(source)).toMatch(/^root = /)
  })
  it.each([
    "root = Text(123);",
    'root = Text("kept", "silently dropped");',
    'root = Stack([Text("kept"),null]);',
    'root = Tabs([Text("not a tab"),Text("not a tab")]);',
    'root = Chart("unknown");',
    'root = DataTable("completion");',
    'root = Concept("unknown");',
    'root = Stack([Chart("large"),Chart("large"),Chart("large")]);',
    `root = Stack([${Array(7).fill('Concept("compact")').join(",")}]);`,
  ])(
    "rejects invalid content instead of accepting a partial answer: %s",
    (source) => {
      expect(() => prepareOpenui(source)).toThrow()
    }
  )
})
