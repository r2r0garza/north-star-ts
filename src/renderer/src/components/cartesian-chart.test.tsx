// @vitest-environment happy-dom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { describe, expect, it, vi } from "vitest"
import { CartesianChart } from "./cartesian-chart"

const props = vi.hoisted(() => new Map<string, Record<string, unknown>[]>())
vi.mock("recharts", async () => {
  const { createElement } = await import("react")
  const component = (name: string) => (value: Record<string, unknown>) => {
    props.set(name, [...(props.get(name) ?? []), value])
    return createElement(
      "div",
      { "data-chart-part": name },
      value.children as never
    )
  }
  return Object.fromEntries(
    [
      "Area",
      "AreaChart",
      "Bar",
      "BarChart",
      "CartesianGrid",
      "Line",
      "LineChart",
      "XAxis",
      "YAxis",
    ].map((name) => [name, component(name)])
  )
})
vi.mock("@/components/ui/chart", () => ({
  ChartContainer: ({
    config,
    children,
  }: {
    config: Record<string, unknown>
    children: React.ReactNode
  }) => {
    props.set("config", [config])
    return <div>{children}</div>
  },
  ChartTooltip: () => null,
  ChartTooltipContent: () => null,
  ChartLegend: () => null,
  ChartLegendContent: () => null,
}))
function render(snapshot: boolean, kind: "line" | "area" | "bar") {
  props.clear()
  const container = document.createElement("div")
  const root = createRoot(container)
  act(() =>
    root.render(
      <CartesianChart
        config={{
          chartKind: kind,
          xKey: "category",
          series: [
            { key: "series0", label: "Observed", color: "var(--chart-1)" },
          ],
        }}
        rows={[
          { category: "Jan", series0: 0 },
          { category: "Feb", series0: null },
        ]}
        snapshot={snapshot}
        formatValue={(value) => `${value} currency units`}
        formatTickValue={(value) => String(value)}
      />
    )
  )
  act(() => root.unmount())
}
describe("shared Cartesian chart presentation", () => {
  it.each(["line", "area", "bar"] as const)(
    "renders %s snapshots with animation off and supplied category order",
    (kind) => {
      render(true, kind)
      const seriesName =
        kind === "line" ? "Line" : kind === "area" ? "Area" : "Bar"
      expect(props.get(seriesName)?.[0]).toMatchObject({
        dataKey: "series0",
        isAnimationActive: false,
      })
      expect(props.get(`${seriesName}Chart`)?.[0].data).toEqual([
        { category: "Jan", series0: 0 },
        { category: "Feb", series0: null },
      ])
      if (kind !== "bar")
        expect(props.get(seriesName)?.[0].connectNulls).toBe(false)
      expect(props.get("XAxis")?.[0].dataKey).toBe("category")
      expect(props.get("YAxis")?.[0].width).toBe(72)
      expect(props.get(`${seriesName}Chart`)?.[0].margin).toEqual({
        top: 16,
        right: 12,
        bottom: 8,
        left: 0,
      })
      const formatter = props.get("YAxis")?.[0].tickFormatter as (
        value: number
      ) => string
      expect(formatter(24000)).toBe("24000")
      expect(props.get("XAxis")?.[0].tick).toEqual({
        fill: "var(--muted-foreground)",
      })
      expect(props.get("YAxis")?.[0].tick).toEqual({
        fill: "var(--muted-foreground)",
      })
    }
  )
  it("retains legacy dashboard animation defaults, colors and axis width", () => {
    render(false, "line")
    expect(props.get("Line")?.[0].isAnimationActive).toBeUndefined()
    expect(props.get("Line")?.[0].stroke).toBe("var(--chart-1)")
    expect(props.get("YAxis")?.[0].width).toBe(36)
    expect(props.get("LineChart")?.[0].margin).toBeUndefined()
  })
})
