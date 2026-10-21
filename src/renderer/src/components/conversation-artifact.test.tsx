// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  ConversationArtifact,
  formatChartValue,
  snapshotChartModel,
} from "./conversation-artifact"
import {
  validateChartSnapshot,
  type ArtifactReference,
} from "../../../shared/conversation-artifacts"

const renders = vi.hoisted(() => ({ chart: vi.fn() }))
vi.mock("@/components/cartesian-chart", () => ({
  SERIES_COLORS: ["var(--chart-1)", "var(--chart-2)"],
  CartesianChart: (props: unknown) => {
    renders.chart(props)
    return <div data-testid="chart" />
  },
}))
const snapshot = validateChartSnapshot({
  title: "Revenue",
  description: "Observed revenue",
  source: "<script>source</script>",
  dataAsOf: "2026-10-21",
  chartKind: "line",
  xKey: "month",
  unit: "USD",
  series: [{ key: "external_key", label: "Enterprise" }],
  data: [
    { month: "Jan", external_key: 0 },
    { month: "Feb", external_key: null },
  ],
})
const reference: ArtifactReference = {
  schemaVersion: 1,
  artifactId: "artifact-1",
  revision: 1,
  title: "Revenue",
  kind: "chart",
  rowCount: 2,
}
function envelope(overrides = {}) {
  return {
    schemaVersion: 1,
    conversationId: "conversation",
    invocationId: "invocation",
    reference,
    snapshot,
    ...overrides,
  }
}
let root: Root
let container: HTMLDivElement
let read: ReturnType<typeof vi.fn>
beforeEach(() => {
  renders.chart.mockClear()
  read = vi.fn().mockResolvedValue({ artifact: envelope() })
  vi.stubGlobal("cowork", undefined)
  Object.defineProperty(window, "cowork", {
    configurable: true,
    value: { db: { artifacts: { read } } },
  })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
async function render(ref = reference, conversationId = "conversation") {
  await act(async () => {
    root.render(
      <ConversationArtifact reference={ref} conversationId={conversationId} />
    )
  })
}
describe("conversation chart snapshots", () => {
  it("loads exact scoped revision, escapes attribution and maps data to host-owned keys", async () => {
    await render()
    expect(read).toHaveBeenCalledWith("conversation", "artifact-1", 1)
    expect(container.textContent).toContain("Source: <script>source</script>")
    expect(container.querySelector("script")).toBeNull()
    expect(container.textContent).toContain("Data as of: 2026-10-21")
    expect(container.textContent).toContain("Unit: USD")
    const model = snapshotChartModel(snapshot)
    expect(model.config.series).toEqual([
      {
        key: "series0",
        label: "Enterprise",
        color: "var(--artifact-series-1)",
      },
    ])
    expect(model.rows).toEqual([
      { category: "Jan", series0: 0 },
      { category: "Feb", series0: null },
    ])
    expect(JSON.stringify(model)).not.toContain("external_key")
    expect(renders.chart.mock.calls[0][0]).toMatchObject({
      snapshot: true,
      config: model.config,
      rows: model.rows,
    })
  })
  it("does not refetch or rerender a chart on unrelated parent updates", async () => {
    await render()
    const count = renders.chart.mock.calls.length
    await render({ ...reference })
    expect(read).toHaveBeenCalledOnce()
    expect(renders.chart).toHaveBeenCalledTimes(count)
  })
  it("shows readable empty data rather than a fictional chart", async () => {
    read.mockResolvedValue({
      artifact: envelope({ snapshot: { ...snapshot, data: [] } }),
    })
    await render()
    expect(container.textContent).toContain("No observations supplied.")
    expect(renders.chart).not.toHaveBeenCalled()
  })
  it.each([
    { error: "missing" },
    { artifact: envelope({ schemaVersion: 99 }) },
    { artifact: envelope({ conversationId: "other" }) },
    { artifact: envelope({ reference: { ...reference, revision: 2 } }) },
    { artifact: envelope({ snapshot: { ...snapshot, schemaVersion: 2 } }) },
    {
      artifact: envelope({
        snapshot: {
          ...snapshot,
          data: [{ month: "Jan", external_key: "not numeric" }],
        },
      }),
    },
  ])(
    "shows bounded fallback for missing, corrupt or mismatched content %#",
    async (result) => {
      read.mockResolvedValue(result)
      await render()
      expect(container.textContent).toContain("Chart unavailable")
      expect(renders.chart).not.toHaveBeenCalled()
    }
  )
  it("ignores stale reads after switching conversations", async () => {
    let resolve!: (result: unknown) => void
    read
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r
          })
      )
      .mockResolvedValue({ error: "missing" })
    await render()
    await render(reference, "other")
    await act(async () => {
      resolve({ artifact: envelope() })
    })
    expect(container.textContent).toContain("Chart unavailable")
    expect(renders.chart).not.toHaveBeenCalled()
  })
  it("formats explicit units and percent fractions without timestamp conversion", () => {
    expect(formatChartValue(snapshot, 0)).toContain("0 USD")
    expect(
      formatChartValue({ ...snapshot, numberFormat: "percent", unit: "%" }, 0.5)
    ).toContain("50")
  })
})

import { validateTableSnapshot } from "../../../shared/conversation-artifacts"
import { artifactToolSegments } from "./transcript-tools"
async function clickText(text: string) {
  const button = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === text
  )!
  expect(button).toBeTruthy()
  await act(async () => button.click())
}
describe("artifact data and expanded presentation", () => {
  it("switches charts to an accessible table without refetching or inventing zeros", async () => {
    await render()
    await clickText("View data")
    expect(container.querySelector("table")).toBeTruthy()
    expect(container.querySelector("th")?.getAttribute("scope")).toBe("col")
    expect(container.textContent).toContain("0 USD")
    expect(container.textContent).toContain("No value")
    expect(read).toHaveBeenCalledOnce()
    await clickText("Show chart")
    expect(container.querySelector("table")).toBeNull()
  })
  it("sorts table cells locally, resets order, and keeps saved rows immutable", async () => {
    const table = validateTableSnapshot({
      title: "Results",
      columns: [{ key: "score", label: "Score", valueType: "number" }],
      data: [{ score: 10 }, { score: 2 }, { score: null }, { score: 0 }],
    })
    const tableReference = { ...reference, kind: "table" as const }
    read.mockResolvedValue({
      artifact: envelope({ reference: tableReference, snapshot: table }),
    })
    await render(tableReference)
    const values = () =>
      [...container.querySelectorAll("tbody td")].map(
        (cell) => cell.textContent
      )
    expect(values()).toEqual(["10", "2", "No value", "0"])
    await clickText("Score")
    expect(values()).toEqual(["0", "2", "10", "No value"])
    expect(container.querySelector("th")?.getAttribute("aria-sort")).toBe(
      "ascending"
    )
    await clickText("Score")
    expect(values()).toEqual(["10", "2", "0", "No value"])
    await clickText("Reset order")
    expect(values()).toEqual(["10", "2", "No value", "0"])
    expect(table.data.map((row) => row.score)).toEqual([10, 2, null, 0])
    expect(read).toHaveBeenCalledOnce()
  })
  it("opens a labelled expanded dialog retaining attribution and local data controls", async () => {
    await render()
    await clickText("Expand")
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog).toBeTruthy()
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy()
    expect(dialog.textContent).toContain("Source: <script>source</script>")
    expect(dialog.textContent).toContain("Data as of: 2026-10-21")
    expect(read).toHaveBeenCalledOnce()
    await clickText("Close")
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
  it("segments mixed adjacent presentation calls in tool-call order", () => {
    const calls = ["present_table", "present_chart", "present_table"].map(
      (name, i) => ({
        id: String(i),
        name,
        label: name,
        rawArgs: "{}",
        args: {},
        status: "done" as const,
      })
    )
    expect(
      artifactToolSegments([...calls, calls[0]]).map(
        (segment) => segment.artifactCall?.id
      )
    ).toEqual(["0", "1", "2"])
  })
})
