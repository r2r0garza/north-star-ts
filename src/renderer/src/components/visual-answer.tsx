import { Component, useState, type ReactNode } from "react"
import type { ElementNode } from "@openuidev/lang-core"
import { visualTree, type VisualSnapshot } from "../../../shared/openui-visual"
import { CartesianChart } from "./cartesian-chart"
import {
  formatChartValue,
  snapshotChartModel,
  SnapshotData,
} from "./conversation-artifact"
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card"
import { Button } from "./ui/button"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs"

class VisualBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? (
      <p role="alert">
        Visual answer unavailable: rendering failed. No complete answer is
        shown.
      </p>
    ) : (
      this.props.children
    )
  }
}
function Dataset({ id, snapshot }: { id: string; snapshot: VisualSnapshot }) {
  const data = snapshot.datasets.find((d) => d.id === id)!.snapshot
  const [viewData, setViewData] = useState(false)
  const model = data.kind === "chart" ? snapshotChartModel(data) : null
  return (
    <section className="min-w-0 space-y-2">
      <h4 className="text-sm font-medium">{data.title}</h4>
      {data.description && (
        <p className="text-xs text-muted-foreground">{data.description}</p>
      )}
      {data.source && (
        <p className="text-xs break-words text-muted-foreground">
          Source: {data.source} (attribution, not verification)
        </p>
      )}
      {data.dataAsOf && (
        <p className="text-xs text-muted-foreground">
          Data as of: {data.dataAsOf}
        </p>
      )}
      {!data.data.length ? (
        <p>No observations supplied.</p>
      ) : (
        <>
          {data.kind === "chart" && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setViewData(!viewData)}
            >
              {viewData ? "Show chart" : "View data"}
            </Button>
          )}
          {model && data.kind === "chart" && !viewData ? (
            <div className="h-72 min-w-0">
              <CartesianChart
                {...model}
                snapshot
                formatValue={(v) => formatChartValue(data, v)}
                formatTickValue={(v) =>
                  formatChartValue({ numberFormat: data.numberFormat }, v)
                }
              />
            </div>
          ) : (
            <SnapshotData snapshot={data} />
          )}
        </>
      )}
    </section>
  )
}
function Node({
  node,
  snapshot,
}: {
  node: ElementNode
  snapshot: VisualSnapshot
}) {
  const p = node.props
  const children = (nodes: unknown) =>
    (nodes as ElementNode[]).map((child, i) => (
      <Node key={i} node={child} snapshot={snapshot} />
    ))
  switch (node.typeName) {
    case "Stack":
      return <div className="min-w-0 space-y-4">{children(p.children)}</div>
    case "Row":
      return (
        <div className="flex min-w-0 flex-wrap gap-4 [&>*]:min-w-0 [&>*]:flex-1">
          {children(p.children)}
        </div>
      )
    case "Text":
      return <p className="text-sm break-words">{String(p.text)}</p>
    case "Card":
      return (
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>{String(p.title)}</CardTitle>
          </CardHeader>
          <CardContent>{children(p.children)}</CardContent>
        </Card>
      )
    case "Metric":
      return (
        <div className="border-l-2 pl-3">
          <p className="text-xs break-words text-muted-foreground">
            {String(p.label)}
          </p>
          <p className="text-2xl font-semibold tabular-nums">
            {formatChartValue(
              { numberFormat: p.format as "number" | "percent" | "integer" },
              p.value as number
            )}
          </p>
        </div>
      )
    case "Chart":
    case "DataTable":
      return <Dataset id={String(p.id)} snapshot={snapshot} />
    case "Tabs": {
      const tabs = p.tabs as ElementNode[]
      return (
        <Tabs defaultValue="0">
          <TabsList className="h-auto max-w-full flex-wrap">
            {tabs.map((tab, i) => (
              <TabsTrigger key={i} value={String(i)}>
                {String(tab.props.label)}
              </TabsTrigger>
            ))}
          </TabsList>
          {tabs.map((tab, i) => (
            <TabsContent key={i} value={String(i)}>
              {children(tab.props.children)}
            </TabsContent>
          ))}
        </Tabs>
      )
    }
    default:
      throw new Error("Unsupported visual node")
  }
}
export function VisualAnswer({ snapshot }: { snapshot: VisualSnapshot }) {
  let root: ElementNode
  try {
    root = visualTree(snapshot.document, snapshot.datasets)
  } catch {
    return <p role="alert">Visual answer unavailable: invalid saved content.</p>
  }
  return (
    <VisualBoundary>
      <div
        className="min-w-0"
        onKeyDown={(event) => {
          if (event.key !== "Escape") event.stopPropagation()
        }}
      >
        <Node node={root} snapshot={snapshot} />
      </div>
    </VisualBoundary>
  )
}
