import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from "@/components/ui/chart"

export const SERIES_COLORS = [
  "var(--chart-1, #2563eb)",
  "var(--chart-2, #16a34a)",
  "var(--chart-3, #d97706)",
  "var(--chart-4, #dc2626)",
  "var(--chart-5, #7c3aed)",
]
export interface ChartSeries {
  key: string
  label?: string
  color?: string
}
export interface ChartWidgetConfig {
  chartKind?: "line" | "bar" | "area"
  xKey?: string
  series?: ChartSeries[]
}

// Dashboard callers retain their legacy defaults; snapshots adapt validated data
// to host-generated keys before entering this presentation-only component.
export function CartesianChart({
  config,
  rows,
  snapshot = false,
  formatValue,
  formatTickValue,
}: {
  config: ChartWidgetConfig
  rows: Array<Record<string, unknown>>
  snapshot?: boolean
  formatValue?: (value: number) => string
  formatTickValue?: (value: number) => string
}) {
  const xKey = config.xKey ?? "name"
  const series: ChartSeries[] = config.series?.length
    ? config.series
    : Object.keys(rows[0] ?? {})
        .filter((k) => k !== xKey && typeof rows[0]?.[k] === "number")
        .map((key) => ({ key }))
  const chartConfig: ChartConfig = Object.fromEntries(
    series.map((s, i) => [
      s.key,
      {
        label: s.label ?? s.key,
        color: s.color ?? SERIES_COLORS[i % SERIES_COLORS.length],
      },
    ])
  )
  const common = {
    data: rows,
    ...(snapshot ? { margin: { top: 16, right: 12, bottom: 8, left: 0 } } : {}),
  }
  const axes = (
    <>
      <CartesianGrid vertical={false} />
      <XAxis
        dataKey={xKey}
        tickLine={false}
        axisLine={false}
        tick={snapshot ? { fill: "var(--muted-foreground)" } : undefined}
      />
      <YAxis
        tickLine={false}
        axisLine={false}
        width={snapshot ? 72 : 36}
        tick={snapshot ? { fill: "var(--muted-foreground)" } : undefined}
        tickFormatter={formatTickValue ?? formatValue}
      />
      <ChartTooltip
        content={
          <ChartTooltipContent
            formatter={
              formatValue
                ? (value, name) => (
                    <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1">
                      <span className="break-words text-muted-foreground">
                        {chartConfig[String(name)]?.label ?? name}
                      </span>
                      <span className="tabular-nums">
                        {typeof value === "number"
                          ? formatValue(value)
                          : String(value ?? "No observation")}
                      </span>
                    </div>
                  )
                : undefined
            }
          />
        }
      />
      <ChartLegend
        content={
          <ChartLegendContent
            className={snapshot ? "flex-wrap gap-y-2" : undefined}
          />
        }
      />
    </>
  )
  const animation = snapshot ? { isAnimationActive: false } : {}
  return (
    <ChartContainer config={chartConfig} className="h-full w-full">
      {config.chartKind === "bar" ? (
        <BarChart {...common}>
          {axes}
          {series.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              fill={s.color ?? SERIES_COLORS[i % SERIES_COLORS.length]}
              radius={4}
              {...animation}
            />
          ))}
        </BarChart>
      ) : config.chartKind === "area" ? (
        <AreaChart {...common}>
          {axes}
          {series.map((s, i) => (
            <Area
              key={s.key}
              dataKey={s.key}
              stroke={s.color ?? SERIES_COLORS[i % SERIES_COLORS.length]}
              fill={s.color ?? SERIES_COLORS[i % SERIES_COLORS.length]}
              fillOpacity={0.2}
              {...(snapshot ? { dot: { r: 2 } } : {})}
              connectNulls={false}
              {...animation}
            />
          ))}
        </AreaChart>
      ) : (
        <LineChart {...common}>
          {axes}
          {series.map((s, i) => (
            <Line
              key={s.key}
              dataKey={s.key}
              stroke={s.color ?? SERIES_COLORS[i % SERIES_COLORS.length]}
              dot={snapshot ? { r: 2 } : false}
              connectNulls={false}
              {...animation}
            />
          ))}
        </LineChart>
      )}
    </ChartContainer>
  )
}
