import { describe, expect, it } from "vitest"
import { validateArtifactSnapshot } from "./conversation-artifacts"
import {
  comparisonChart,
  comparisonTable,
  openuiComparisonFixtures,
} from "./openui-comparison.fixture"

describe("PR131 fixed comparison baseline", () => {
  it("keeps every expressible snapshot within existing artifact contracts", () => {
    for (const fixture of openuiComparisonFixtures)
      for (const snapshot of fixture.snapshots)
        expect(validateArtifactSnapshot(snapshot)).toEqual(snapshot)
    expect(
      new Set(openuiComparisonFixtures.map((fixture) => fixture.id)).size
    ).toBe(6)
  })

  it("preserves percentages, explicit gaps and category order across chart/table", () => {
    expect(comparisonTable.data).toEqual(comparisonChart.data)
    expect(comparisonChart.data.map((row) => row.rate)).toEqual([
      0.25,
      null,
      0.75,
    ])
    expect(comparisonChart.numberFormat).toBe("percent")
    expect(comparisonTable.columns[1].numberFormat).toBe("percent")
    expect(openuiComparisonFixtures.at(-1)?.snapshots).toEqual([])
  })
})
