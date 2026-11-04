import { useState } from "react"
import { createLibrary, defineComponent, Renderer } from "@openuidev/react-lang"
import { createParser, type ElementNode } from "@openuidev/lang-core"
import { z } from "zod/v4"
import { admitStaticOpenui } from "../../src/shared/openui-static-admission"
import {
  comparisonChart,
  comparisonTable,
  openuiComparisonFixtures,
} from "../../src/shared/openui-comparison.fixture"
import {
  validateArtifactSnapshot,
  type UiConceptSnapshot,
  type ChartSnapshot,
  type TableSnapshot,
} from "../../src/shared/conversation-artifacts"
import {
  snapshotChartModel,
  formatChartValue,
  SnapshotData,
} from "../../src/renderer/src/components/conversation-artifact"
import { CartesianChart } from "../../src/renderer/src/components/cartesian-chart"
import { UiConceptPreview } from "../../src/renderer/src/components/ui-concept-preview"
import {
  Card as HostCard,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../src/renderer/src/components/ui/card"
import {
  Tabs as HostTabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "../../src/renderer/src/components/ui/tabs"
import { Button } from "../../src/renderer/src/components/ui/button"

const large = openuiComparisonFixtures[4].snapshots[0]
export const datasets: Record<string, ChartSnapshot | TableSnapshot> = {
  completion: comparisonChart,
  supporting: comparisonTable,
  large,
  "large-table": { ...comparisonTable, data: large.data },
  empty: { ...comparisonTable, title: "Synthetic empty result", data: [] },
}
for (const snapshot of Object.values(datasets))
  validateArtifactSnapshot(snapshot)

export const concept: UiConceptSnapshot = {
  kind: "ui_concept",
  schemaVersion: 1,
  title: "Illustrative notification settings",
  tree: {
    type: "stack",
    children: [
      { type: "text", role: "heading", text: "Notification preferences" },
      { type: "button", text: "Open details", goTo: "details" },
    ],
  },
  states: [
    {
      id: "details",
      label: "Notification details",
      tree: {
        type: "stack",
        children: [
          { type: "text", role: "heading", text: "Weekly digest details" },
          { type: "button", text: "Back to preferences", goTo: "initial" },
        ],
      },
    },
  ],
}
validateArtifactSnapshot(concept)

export function Snapshot({ id }: { id: string }) {
  const snapshot = datasets[id]
  const [dataView, setDataView] = useState(false)
  if (!snapshot) throw new Error("Unknown snapshot")
  const model = snapshot.kind === "chart" ? snapshotChartModel(snapshot) : null
  return (
    <section className="min-w-0 space-y-3" aria-label={snapshot.title}>
      <h3 className="text-sm font-medium">{snapshot.title}</h3>
      <p className="text-xs break-words text-muted-foreground">
        {snapshot.source}. As of {snapshot.dataAsOf}. Attribution, not
        verification.
      </p>
      {!snapshot.data.length ? (
        <p>No observations supplied.</p>
      ) : (
        <>
          {snapshot.kind === "chart" && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDataView(!dataView)}
            >
              {dataView ? "Show chart" : "View data"}
            </Button>
          )}
          {model && snapshot.kind === "chart" && !dataView ? (
            <div className="h-72 min-w-0">
              <CartesianChart
                {...model}
                snapshot
                formatValue={(v) => formatChartValue(snapshot, v)}
              />
            </div>
          ) : (
            <SnapshotData snapshot={snapshot} />
          )}
        </>
      )}
    </section>
  )
}

const text = z.string().max(2000)
const children = z.array(z.any()).max(200)
const Stack = defineComponent({
  name: "Stack",
  description: "Vertical presentation layout",
  props: z.object({ children }).strict(),
  component: ({ props, renderNode }) => (
    <div className="min-w-0 space-y-5">{renderNode(props.children)}</div>
  ),
})
const Row = defineComponent({
  name: "Row",
  description: "Wrapping metrics or cards",
  props: z.object({ children }).strict(),
  component: ({ props, renderNode }) => (
    <div className="flex min-w-0 flex-wrap gap-4 [&>*]:min-w-0 [&>*]:flex-1">
      {renderNode(props.children)}
    </div>
  ),
})
const Text = defineComponent({
  name: "Text",
  description: "Plain explanatory text",
  props: z.object({ text }).strict(),
  component: ({ props }) => <p className="text-sm break-words">{props.text}</p>,
})
const Card = defineComponent({
  name: "Card",
  description: "Titled group",
  props: z.object({ title: text, children }).strict(),
  component: ({ props, renderNode }) => (
    <HostCard className="min-w-0">
      <CardHeader>
        <CardTitle>{props.title}</CardTitle>
      </CardHeader>
      <CardContent>{renderNode(props.children)}</CardContent>
    </HostCard>
  ),
})
const Metric = defineComponent({
  name: "Metric",
  description: "Already calculated metric; percentages are fractions",
  props: z
    .object({
      label: text,
      value: z.number().finite(),
      format: z.enum(["number", "percent", "integer"]),
    })
    .strict(),
  component: ({ props }) => (
    <div className="min-w-0 border-l-2 pl-3">
      <p className="text-xs break-words text-muted-foreground">{props.label}</p>
      <p className="text-2xl font-semibold tabular-nums">
        {formatChartValue({ numberFormat: props.format }, props.value)}
      </p>
    </div>
  ),
})
const Chart = defineComponent({
  name: "Chart",
  description: "Existing supplied chart snapshot by id",
  props: z.object({ id: z.enum(["completion", "large"]) }).strict(),
  component: ({ props }) => <Snapshot id={props.id} />,
})
const DataTable = defineComponent({
  name: "DataTable",
  description: "Existing supplied table snapshot by id",
  props: z
    .object({ id: z.enum(["supporting", "large-table", "empty"]) })
    .strict(),
  component: ({ props }) => <Snapshot id={props.id} />,
})
const Tab = defineComponent({
  name: "Tab",
  description: "One local tab",
  props: z.object({ label: text, children }).strict(),
  component: ({ props, renderNode }) => <>{renderNode(props.children)}</>,
})
const Tabs = defineComponent({
  name: "Tabs",
  description: "Ephemeral component-owned tabs",
  props: z.object({ tabs: z.array(z.any()).min(2).max(6) }).strict(),
  component: ({ props, renderNode }) => (
    <HostTabs defaultValue="0">
      <TabsList className="h-auto max-w-full flex-wrap">
        {props.tabs.map((tab: ElementNode, i: number) => (
          <TabsTrigger key={i} value={String(i)}>
            {String(tab.props.label)}
          </TabsTrigger>
        ))}
      </TabsList>
      {props.tabs.map((tab: ElementNode, i: number) => (
        <TabsContent key={i} value={String(i)}>
          {renderNode(tab.props.children)}
        </TabsContent>
      ))}
    </HostTabs>
  ),
})
const Concept = defineComponent({
  name: "Concept",
  description:
    "Existing illustrative multi-screen demo; not analytical findings",
  props: z.object({ layout: z.enum(["compact", "card"]) }).strict(),
  component: ({ props }) => (
    <UiConceptPreview
      concept={{
        ...concept,
        tree:
          props.layout === "card"
            ? {
                type: "card",
                title: "Grouped preferences",
                children: [concept.tree!],
              }
            : concept.tree!,
      }}
    />
  ),
})

export const library = createLibrary({
  components: [
    Stack,
    Row,
    Text,
    Card,
    Metric,
    Chart,
    DataTable,
    Tabs,
    Tab,
    Concept,
  ],
  root: "Stack",
})
const parser = createParser(library.toJSONSchema())

export function prepareOpenui(source: string): string {
  const admitted = admitStaticOpenui(source)
  const result = parser.parse(admitted)
  if (
    !result.root ||
    result.meta.incomplete ||
    result.meta.errors.length ||
    result.meta.unresolved.length ||
    result.meta.orphaned.length ||
    result.queryStatements.length ||
    result.mutationStatements.length ||
    Object.keys(result.stateDeclarations).length
  )
    throw new Error("Incomplete or invalid presentation; nothing rendered.")
  let count = 0
  let renderedRows = 0
  let concepts = 0
  const visit = (node: ElementNode, depth: number) => {
    if (
      !node ||
      node.type !== "element" ||
      node.partial ||
      node.hasDynamicProps ||
      depth > 12 ||
      ++count > 200
    )
      throw new Error("Invalid or oversized presentation tree.")
    const component = library.components[node.typeName]
    if (!component) throw new Error("Unknown component")
    component.props.parse(node.props)
    if (node.typeName === "Chart" || node.typeName === "DataTable") {
      renderedRows += datasets[String(node.props.id)].data.length
      if (renderedRows > 2000)
        throw new Error("Snapshot rendering row budget exceeded")
    }
    if (node.typeName === "Concept" && ++concepts > 6)
      throw new Error("Demo rendering budget exceeded")
    if (node.typeName === "Tabs") {
      const tabs = node.props.tabs as ElementNode[]
      if (tabs.some((tab) => tab?.typeName !== "Tab"))
        throw new Error("Tabs require Tab children")
      tabs.forEach((tab) => visit(tab, depth + 1))
    } else if (
      node.typeName === "Stack" ||
      node.typeName === "Row" ||
      node.typeName === "Card" ||
      node.typeName === "Tab"
    ) {
      const nodes = node.props.children as ElementNode[]
      nodes.forEach((child) => visit(child, depth + 1))
    }
  }
  visit(result.root, 0)
  return admitted
}

export function StaticAnswer({ source }: { source: string }) {
  const [errors, setErrors] = useState<string[]>([])
  let admitted: string
  try {
    admitted = prepareOpenui(source)
  } catch (error) {
    return <p role="alert">Presentation rejected: {(error as Error).message}</p>
  }
  return (
    <>
      {errors.length > 0 && (
        <p role="alert">Presentation incomplete: {errors.join("; ")}</p>
      )}
      <div hidden={errors.length > 0}>
        <Renderer
          key={admitted}
          library={library}
          response={admitted}
          isStreaming={false}
          toolProvider={null}
          publishObservability={false}
          onError={(issues) => setErrors(issues.map((issue) => issue.message))}
        />
      </div>
    </>
  )
}
