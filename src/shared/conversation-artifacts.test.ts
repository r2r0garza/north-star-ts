import { describe, expect, it } from "vitest"
import {
  ARTIFACT_LIMITS,
  validateChartSnapshot,
} from "./conversation-artifacts"

export const chartInput = {
  title: "Revenue",
  chartKind: "line",
  xKey: "month",
  series: [{ key: "revenue", label: "Revenue" }],
  data: [
    { month: "Jan", revenue: 0 },
    { month: "Feb", revenue: null },
  ],
}

describe("chart snapshot contract", () => {
  it("preserves explicit zero, null, category order, metadata and empty datasets", () => {
    expect(
      validateChartSnapshot({
        ...chartInput,
        source: "Unverified label",
        dataAsOf: "2026-01-01",
      })
    ).toMatchObject({
      kind: "chart",
      schemaVersion: 1,
      data: chartInput.data,
      source: "Unverified label",
      dataAsOf: "2026-01-01",
    })
    expect(validateChartSnapshot({ ...chartInput, data: [] }).data).toEqual([])
  })
  it.each([
    null,
    [],
    "{malformed",
    { ...chartInput, schemaVersion: 2 },
    { ...chartInput, kind: "html" },
    { ...chartInput, chartKind: "pie" },
    { ...chartInput, title: "" },
    { ...chartInput, data: [{ month: "Jan" }] },
    { ...chartInput, data: [{ month: null, revenue: 1 }] },
    { ...chartInput, data: [{ month: "Jan", revenue: Infinity }] },
    { ...chartInput, data: [{ month: "Jan", revenue: NaN }] },
    { ...chartInput, data: [{ month: "Jan", revenue: "3" }] },
    { ...chartInput, data: [{ month: "Jan", revenue: 1, undeclared: 2 }] },
    { ...chartInput, series: [{ key: "month", label: "Duplicate x" }] },
    { ...chartInput, series: [chartInput.series[0], chartInput.series[0]] },
    { ...chartInput, series: [{ key: "a} body{", label: "Injection" }] },
    { ...chartInput, series: [{ key: "constructor", label: "Injection" }] },
    {
      ...chartInput,
      series: [{ ...chartInput.series[0], color: "url(https://example.com)" }],
    },
    { ...chartInput, numberFormat: "function(){}" },
    { ...chartInput, numberFormat: "percent", unit: "USD" },
    { ...chartInput, conversationId: "spoof" },
    { ...chartInput, artifactId: "overwrite" },
    {
      ...chartInput,
      data: Array(ARTIFACT_LIMITS.rows + 1).fill(chartInput.data[0]),
    },
    { ...chartInput, title: "x".repeat(ARTIFACT_LIMITS.label + 1) },
    {
      ...chartInput,
      series: Array(ARTIFACT_LIMITS.series + 1).fill(chartInput.series[0]),
    },
    {
      ...chartInput,
      data: Array(1000).fill({ month: "x".repeat(500), revenue: 1 }),
    },
  ])(
    "rejects malformed, unsupported, unsafe and oversized specifications %#",
    (input) => {
      expect(() => validateChartSnapshot(input)).toThrow()
    }
  )
  it("retains injection-like labels as inert data and detaches supplied rows", () => {
    const input = {
      ...chartInput,
      title: "<script>alert(1)</script>",
      data: [{ month: "Jan", revenue: 1 }],
    }
    const snapshot = validateChartSnapshot(input)
    input.data[0].revenue = 99
    expect(snapshot.title).toBe(input.title)
    expect(snapshot.data[0].revenue).toBe(1)
  })
})

import {
  validateTableSnapshot,
  validateArtifactPresentation,
} from "./conversation-artifacts"
export const tableInput = {
  title: "Results",
  columns: [
    { key: "name", label: "Name", valueType: "string" },
    {
      key: "score",
      label: "Score",
      valueType: "number",
      numberFormat: "percent",
    },
    { key: "active", label: "Active", valueType: "boolean" },
  ],
  data: [
    { name: "<script>inert</script>", score: 0, active: false },
    { name: "", score: null, active: true },
  ],
}
describe("table snapshots and revision input", () => {
  it("preserves typed scalar cells, null, zero, false, text and supplied order", () => {
    const snapshot = validateTableSnapshot(tableInput)
    expect(snapshot).toMatchObject({
      kind: "table",
      schemaVersion: 1,
      data: tableInput.data,
    })
    expect(snapshot.data).not.toBe(tableInput.data)
    expect(validateTableSnapshot({ ...tableInput, data: [] }).data).toEqual([])
  })
  it.each([
    { ...tableInput, columns: [] },
    { ...tableInput, columns: Array(25).fill(tableInput.columns[0]) },
    { ...tableInput, columns: [tableInput.columns[0], tableInput.columns[0]] },
    {
      ...tableInput,
      columns: [{ key: "constructor", label: "Bad", valueType: "string" }],
    },
    {
      ...tableInput,
      columns: [{ ...tableInput.columns[0], numberFormat: "number" }],
    },
    { ...tableInput, columns: [{ ...tableInput.columns[1], unit: "USD" }] },
    {
      ...tableInput,
      columns: [{ ...tableInput.columns[1], numberFormat: "code" }],
    },
    { ...tableInput, data: [{ name: "missing" }] },
    { ...tableInput, data: [{ name: "a", score: Infinity, active: false }] },
    { ...tableInput, data: [{ name: "a", score: "1", active: false }] },
    { ...tableInput, data: [{ name: {}, score: 1, active: false }] },
    { ...tableInput, data: [{ name: "a", score: 1, active: false, extra: 2 }] },
    {
      ...tableInput,
      data: [{ name: "a".repeat(501), score: 1, active: false }],
    },
    { ...tableInput, data: Array(1001).fill(tableInput.data[0]) },
    {
      ...tableInput,
      data: Array(1000).fill({
        name: "a".repeat(500),
        score: 1,
        active: false,
      }),
    },
    { ...tableInput, schemaVersion: 2 },
    { ...tableInput, recipe: "fetch" },
  ])("rejects invalid table specifications %#", (input) =>
    expect(() => validateTableSnapshot(input)).toThrow()
  )
  it("accepts paired revision requests without putting identity into snapshots", () => {
    expect(
      validateArtifactPresentation(
        { ...tableInput, artifactId: "owned-id", expectedBaseRevision: 1 },
        "table"
      )
    ).toMatchObject({ artifactId: "owned-id", expectedBaseRevision: 1 })
    for (const identity of [
      { artifactId: "id" },
      { expectedBaseRevision: 1 },
      { artifactId: "id", expectedBaseRevision: 0 },
      { artifactId: "../other", expectedBaseRevision: 1 },
    ])
      expect(() =>
        validateArtifactPresentation({ ...tableInput, ...identity }, "table")
      ).toThrow()
  })
})
