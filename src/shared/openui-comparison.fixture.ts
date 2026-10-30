import type { ChartSnapshot, TableSnapshot } from "./conversation-artifacts"
import { conceptInput } from "./ui-concept-artifacts.fixture"

export const comparisonChart: ChartSnapshot = {
  kind: "chart",
  schemaVersion: 1,
  title: "Synthetic completion rate",
  source: "Synthetic PR131 comparison data — not observed findings",
  dataAsOf: "2026-10-29",
  chartKind: "line",
  xKey: "period",
  numberFormat: "percent",
  series: [{ key: "rate", label: "Completion rate" }],
  data: [
    {
      period: "First period with a deliberately long category label",
      rate: 0.25,
    },
    { period: "Missing observation", rate: null },
    { period: "Final period", rate: 0.75 },
  ],
}
export const comparisonTable: TableSnapshot = {
  kind: "table",
  schemaVersion: 1,
  title: comparisonChart.title,
  source: comparisonChart.source,
  dataAsOf: comparisonChart.dataAsOf,
  columns: [
    { key: "period", label: "Period", valueType: "string" },
    {
      key: "rate",
      label: "Completion rate",
      valueType: "number",
      numberFormat: "percent",
    },
  ],
  data: comparisonChart.data,
}
export const openuiComparisonFixtures = [
  {
    id: "metrics",
    prompt:
      "Summarize the synthetic final completion rate and number of observed periods. Do not treat a missing observation as zero.",
    baseline:
      "Prose: final rate 75%; two observed periods. No metric component in current tools.",
    snapshots: [],
  },
  {
    id: "mixed",
    prompt:
      "Compose explanatory text, a final-rate metric, a completion-rate chart and the supporting table in one answer surface.",
    baseline:
      "Unsupported as one artifact; separate chart/table plus prose only.",
    snapshots: [comparisonChart, comparisonTable],
  },
  {
    id: "comparison",
    prompt:
      "Compare two illustrative layouts in cards and tabs using the same supplied synthetic completion data.",
    baseline:
      "Cards/tabs supported by present_ui; embedded analytical charts unsupported.",
    snapshots: [{ kind: "ui_concept", schemaVersion: 1, ...conceptInput }],
  },
  {
    id: "concept",
    prompt:
      "Sketch notification settings with two layout alternatives and a local details screen. All content is illustrative and controls are demo-only.",
    baseline:
      "Supported by present_ui; use existing PR116 alternatives and screen-transition regressions.",
    snapshots: [],
  },
  {
    id: "large-and-empty",
    prompt:
      "Show all supplied synthetic rows with percentages, missing observations and long labels; also show a clearly labeled empty result. Preserve category order and inspectable data.",
    baseline:
      "Separate chart/table artifacts; empty data supported. No composed surface.",
    snapshots: [
      {
        ...comparisonChart,
        data: Array.from({ length: 1000 }, (_, i) => ({
          period: `Synthetic period ${i}: long category label`,
          rate: i % 7 === 0 ? null : (i % 101) / 100,
        })),
      },
      { ...comparisonTable, title: "Synthetic empty result", data: [] },
    ],
  },
  {
    id: "prose-control",
    prompt:
      "Explain why missing observations are not zero. No visual is needed.",
    baseline: "Prose; do not call a presentation tool.",
    snapshots: [],
  },
] as const
