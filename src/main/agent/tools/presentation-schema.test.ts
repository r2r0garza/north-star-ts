import { expect, it } from "vitest"
import { presentChartTool } from "./present_chart"
import { presentTableTool } from "./present_table"
import { presentVisualTool } from "./present_visual"

it("preserves shared safe-key and integer guidance inside visual datasets", () => {
  const chart = presentChartTool.definition.function.parameters as any
  const table = presentTableTool.definition.function.parameters as any
  const visual = presentVisualTool.definition.function.parameters as any
  expect(chart.properties.xKey.pattern).toBe("^[A-Za-z][A-Za-z0-9_]*$")
  expect(
    new RegExp(chart.properties.series.items.properties.key.pattern).test(
      "Response time"
    )
  ).toBe(false)
  expect(
    new RegExp(table.properties.columns.items.properties.key.pattern).test(
      "responseTime"
    )
  ).toBe(true)
  expect(
    table.properties.columns.items.properties.valueType.description
  ).toContain('valueType="number" and numberFormat="integer"')
  const [embeddedChart, embeddedTable] =
    visual.properties.datasets.items.properties.snapshot.anyOf
  expect(embeddedChart.properties.xKey).toEqual(chart.properties.xKey)
  expect(embeddedTable.properties.columns).toEqual(table.properties.columns)
  expect(
    embeddedTable.properties.columns.items.properties.unit.description
  ).toContain('omit unit or use "%" only')
})
