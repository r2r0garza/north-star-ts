import { parse, type ElementNode } from "@openuidev/lang-core"
import { admitStaticOpenui } from "./openui-static-admission"
import {
  validateChartSnapshot,
  validateTableSnapshot,
  type ChartSnapshot,
  type TableSnapshot,
} from "./conversation-artifacts"

export const VISUAL_LIBRARY = "north-star-static-v1" as const
export interface VisualSnapshot {
  kind: "visual"
  schemaVersion: 1
  library: typeof VISUAL_LIBRARY
  title: string
  description?: string
  source?: string
  dataAsOf?: string
  document: string
  datasets: Array<{ id: string; snapshot: ChartSnapshot | TableSnapshot }>
}
// Positional ordering is frozen for north-star-static-v1. Core parse avoids React's devtools bootstrap and telemetry wrapper.
const signatures = {
  Stack: ["children"],
  Row: ["children"],
  Text: ["text"],
  Card: ["title", "children"],
  Metric: ["label", "value", "format"],
  Chart: ["id"],
  DataTable: ["id"],
  Tabs: ["tabs"],
  Tab: ["label", "children"],
}
const catalog = new Map(
  Object.entries(signatures).map(([name, params]) => [
    name,
    { params: params.map((name) => ({ name, required: true })) },
  ])
)

export function visualTree(
  document: string,
  datasets: VisualSnapshot["datasets"]
): ElementNode {
  const result = parse(admitStaticOpenui(document), catalog)
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
    throw new Error(
      `Incomplete or invalid visual document.${
        result.meta.errors.length
          ? ` ${result.meta.errors
              .slice(0, 3)
              .map((error) => error.message.slice(0, 300))
              .join(" ")}`
          : ""
      }`
    )
  let nodes = 0,
    rows = 0
  const string = (value: unknown) => {
    if (typeof value !== "string" || !value.trim() || value.length > 2000)
      throw new Error("Expected bounded visual text.")
  }
  const visit = (node: ElementNode, depth: number, parent?: string) => {
    if (
      !node ||
      node.type !== "element" ||
      node.partial ||
      node.hasDynamicProps ||
      ++nodes > 200 ||
      depth > 12 ||
      !Object.hasOwn(signatures, node.typeName)
    )
      throw new Error("Invalid visual tree.")
    const p = node.props
    if (node.typeName === "Text") string(p.text)
    if (node.typeName === "Card") string(p.title)
    if (node.typeName === "Metric") {
      string(p.label)
      if (
        typeof p.value !== "number" ||
        !Number.isFinite(p.value) ||
        !["number", "integer", "percent"].includes(p.format as string)
      )
        throw new Error("Invalid metric.")
    }
    if (node.typeName === "Chart" || node.typeName === "DataTable") {
      const data = datasets.find((d) => d.id === p.id)?.snapshot
      if (
        !data ||
        data.kind !== (node.typeName === "Chart" ? "chart" : "table")
      )
        throw new Error("Unknown or mismatched dataset.")
      rows += data.data.length
      if (rows > 2000) throw new Error("Visual row rendering budget exceeded.")
    }
    if (node.typeName === "Tab") {
      string(p.label)
      if (parent !== "Tabs") throw new Error("Tab must be inside Tabs.")
    }
    const children = node.typeName === "Tabs" ? p.tabs : p.children
    if (["Stack", "Row", "Card", "Tabs", "Tab"].includes(node.typeName)) {
      if (
        !Array.isArray(children) ||
        children.length > 200 ||
        (node.typeName === "Tabs" &&
          (children.length < 2 ||
            children.length > 6 ||
            children.some((c) => c?.typeName !== "Tab")))
      )
        throw new Error("Invalid visual children.")
      children.forEach((child) => visit(child, depth + 1, node.typeName))
    }
  }
  visit(result.root, 0)
  return result.root
}

export function validateVisualSnapshot(input: unknown): VisualSnapshot {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Expected visual object.")
  const v = input as Record<string, unknown>
  if (new TextEncoder().encode(JSON.stringify(v)).length > 256 * 1024)
    throw new Error("Visual exceeds 256 KiB.")
  const allowed = [
    "kind",
    "schemaVersion",
    "library",
    "title",
    "description",
    "source",
    "dataAsOf",
    "document",
    "datasets",
  ]
  if (
    Object.keys(v).some((k) => !allowed.includes(k)) ||
    (v.kind !== undefined && v.kind !== "visual") ||
    (v.schemaVersion !== undefined && v.schemaVersion !== 1) ||
    v.library !== VISUAL_LIBRARY
  )
    throw new Error("Unsupported visual version, library or field.")
  for (const key of ["title", "description", "source", "dataAsOf"]) {
    const value = v[key]
    if (value === undefined && key !== "title") continue
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.length > (key === "description" ? 2000 : 200)
    )
      throw new Error(`Invalid visual ${key}.`)
  }
  if (!Array.isArray(v.datasets) || v.datasets.length > 8)
    throw new Error("Expected at most eight visual datasets.")
  const ids = new Set<string>()
  const datasets = v.datasets.map((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).some((k) => !["id", "snapshot"].includes(k)) ||
      typeof entry.id !== "string" ||
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(entry.id) ||
      ids.has(entry.id)
    )
      throw new Error("Invalid or duplicate dataset id.")
    ids.add(entry.id)
    const snapshot =
      entry.snapshot?.kind === "chart"
        ? validateChartSnapshot(entry.snapshot)
        : entry.snapshot?.kind === "table"
          ? validateTableSnapshot(entry.snapshot)
          : null
    if (!snapshot)
      throw new Error("Visual datasets must be chart/table snapshots.")
    return { id: entry.id as string, snapshot }
  })
  const document = admitStaticOpenui(v.document as string)
  visualTree(document, datasets)
  return {
    kind: "visual",
    schemaVersion: 1,
    library: VISUAL_LIBRARY,
    title: v.title as string,
    ...(v.description !== undefined
      ? { description: v.description as string }
      : {}),
    ...(v.source !== undefined ? { source: v.source as string } : {}),
    ...(v.dataAsOf !== undefined ? { dataAsOf: v.dataAsOf as string } : {}),
    document,
    datasets,
  }
}
