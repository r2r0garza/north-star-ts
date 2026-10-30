import {
  createContext,
  memo,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react"
import {
  validateArtifactSnapshot,
  type ConversationArtifact as ArtifactSnapshot,
  type TableColumn,
  type ArtifactReference,
  type ChartSnapshot,
  type TableSnapshot,
  uiConceptAlternatives,
} from "../../../shared/conversation-artifacts"
import { VisualAnswer } from "./visual-answer"
import { UiConceptPreview } from "@/components/ui-concept-preview"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TableCaption,
} from "@/components/ui/table"
import { CartesianChart } from "@/components/cartesian-chart"

// Provided only where a composer exists (the main conversation view). Choosing
// a direction drafts a host-tagged note for the user to send; it never sends,
// approves or edits anything itself.
export interface ArtifactChoice {
  artifactId: string
  revision: number
  alternative?: { id: string; label: string }
}
export const ArtifactChoiceContext = createContext<
  ((choice: ArtifactChoice) => void) | undefined
>(undefined)

const KIND_LABEL: Record<ArtifactReference["kind"], string> = {
  chart: "Chart",
  table: "Table",
  ui_concept: "UI concept",
  visual: "Visual answer",
}

const SNAPSHOT_COLORS = Array.from(
  { length: 5 },
  (_, i) => `var(--artifact-series-${i + 1})`
)

export function snapshotChartModel(snapshot: ChartSnapshot) {
  return {
    config: {
      chartKind: snapshot.chartKind,
      xKey: "category",
      series: snapshot.series.map((series, index) => ({
        key: `series${index}`,
        label: series.label,
        color: SNAPSHOT_COLORS[index % SNAPSHOT_COLORS.length],
      })),
    },
    rows: snapshot.data.map((row) =>
      Object.fromEntries([
        ["category", row[snapshot.xKey]],
        ...snapshot.series.map((series, index) => [
          `series${index}`,
          row[series.key],
        ]),
      ])
    ),
  }
}

export function formatChartValue(
  snapshot: Pick<ChartSnapshot, "numberFormat" | "unit">,
  value: number
): string {
  const formatted = new Intl.NumberFormat(undefined, {
    style: snapshot.numberFormat === "percent" ? "percent" : "decimal",
    maximumFractionDigits: snapshot.numberFormat === "integer" ? 0 : 2,
  }).format(value)
  return snapshot.unit && snapshot.numberFormat !== "percent"
    ? `${formatted} ${snapshot.unit}`
    : formatted
}

const SnapshotChart = memo(function SnapshotChart({
  snapshot,
}: {
  snapshot: ChartSnapshot
}) {
  const model = useMemo(() => snapshotChartModel(snapshot), [snapshot])
  return (
    <div className="h-72 w-full min-w-0">
      <CartesianChart
        {...model}
        snapshot
        formatValue={(value) => formatChartValue(snapshot, value)}
        formatTickValue={(value) =>
          formatChartValue({ numberFormat: snapshot.numberFormat }, value)
        }
      />
    </div>
  )
})

export const ConversationArtifact = memo(function ConversationArtifact({
  reference,
  conversationId,
}: {
  reference: ArtifactReference
  conversationId?: string
}) {
  const titleId = useId()
  const descriptionId = useId()
  const [state, setState] = useState<{
    snapshot?: ArtifactSnapshot
    error?: string
  }>({})
  const { artifactId, revision, schemaVersion, kind } = reference
  useEffect(() => {
    let active = true
    setState({})
    if (
      !conversationId ||
      schemaVersion !== 1 ||
      !Object.hasOwn(KIND_LABEL, kind)
    ) {
      setState({
        error: `${KIND_LABEL[kind] ?? "Artifact"} unavailable: missing conversation or unsupported version.`,
      })
      return
    }
    void Promise.resolve()
      .then(() =>
        window.cowork.db.artifacts.read(conversationId, artifactId, revision)
      )
      .then((result) => {
        if (!active) return
        try {
          const artifact = result.artifact
          if (
            result.error ||
            !artifact ||
            artifact.schemaVersion !== 1 ||
            artifact.conversationId !== conversationId ||
            artifact.reference.artifactId !== artifactId ||
            artifact.reference.revision !== revision ||
            artifact.snapshot.schemaVersion !== 1 ||
            artifact.snapshot.kind !== kind ||
            artifact.reference.kind !== kind
          )
            throw new Error("Unavailable chart")
          setState({ snapshot: validateArtifactSnapshot(artifact.snapshot) })
        } catch {
          setState({
            error: `${KIND_LABEL[kind]} unavailable: stored content is missing or unsupported.`,
          })
        }
      })
      .catch(() => {
        if (active)
          setState({
            error: `${KIND_LABEL[kind]} unavailable: could not load the saved snapshot.`,
          })
      })
    return () => {
      active = false
    }
  }, [conversationId, artifactId, revision, schemaVersion, kind])
  const snapshot = state.snapshot
  return (
    <figure
      data-artifact-id={artifactId}
      data-artifact-revision={revision}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className="my-2 w-full min-w-0 rounded-lg border bg-background px-3 py-4"
    >
      <figcaption className="mb-3 space-y-1">
        <h3 id={titleId} className="text-sm font-medium break-words">
          {snapshot?.title ?? reference.title}
        </h3>
        <p
          id={descriptionId}
          className="text-xs break-words text-muted-foreground"
        >
          {snapshot?.description ??
            (snapshot
              ? snapshotDescription(snapshot)
              : `Saved ${KIND_LABEL[kind]?.toLowerCase() ?? "artifact"}.`)}
        </p>
        {snapshot?.kind === "chart" && snapshot.unit && (
          <p className="text-xs break-words text-muted-foreground">
            Unit: {snapshot.unit}
          </p>
        )}
        {snapshot?.kind === "ui_concept" && (
          <p className="text-xs text-muted-foreground">Revision {revision}</p>
        )}
        {snapshot?.kind !== "ui_concept" && snapshot?.source && (
          <p className="text-xs break-words text-muted-foreground">
            Source: {snapshot.source}
          </p>
        )}
        {snapshot?.kind !== "ui_concept" && snapshot?.dataAsOf && (
          <p className="text-xs break-words text-muted-foreground">
            Data as of: {snapshot.dataAsOf}
          </p>
        )}
      </figcaption>
      {state.error ? (
        <p role="status" className="text-sm text-muted-foreground">
          {state.error}
        </p>
      ) : snapshot ? (
        snapshot.kind === "ui_concept" ||
        snapshot.kind === "visual" ||
        snapshot.data.length ? (
          <SnapshotPresentation
            snapshot={snapshot}
            artifactId={artifactId}
            revision={revision}
          />
        ) : (
          <p className="py-8 text-sm text-muted-foreground">
            No observations supplied.
          </p>
        )
      ) : (
        <p
          role="status"
          className="flex h-72 items-center justify-center text-sm text-muted-foreground"
        >
          Loading saved {KIND_LABEL[kind]?.toLowerCase() ?? "artifact"}…
        </p>
      )}
    </figure>
  )
})

function snapshotDescription(snapshot: ArtifactSnapshot): string {
  return (
    snapshot.description ??
    (snapshot.kind === "chart"
      ? `${snapshot.chartKind} chart of ${snapshot.series.map((s) => s.label).join(", ")} by ${snapshot.xKey}.`
      : snapshot.kind === "table"
        ? `Table with ${snapshot.data.length} rows and ${snapshot.columns.length} columns.`
        : snapshot.kind === "visual"
          ? "Composed static visual answer."
          : "UI concept mockup.")
  )
}

export function SnapshotData({
  snapshot,
}: {
  snapshot: ChartSnapshot | TableSnapshot
}) {
  const [sort, setSort] = useState<{ key: string; descending: boolean } | null>(
    null
  )
  const columns: TableColumn[] = useMemo(
    () =>
      snapshot.kind === "table"
        ? snapshot.columns
        : [
            { key: snapshot.xKey, label: snapshot.xKey, valueType: "string" },
            ...snapshot.series.map((series) => ({
              ...series,
              valueType: "number" as const,
              numberFormat: snapshot.numberFormat,
              unit: snapshot.unit,
            })),
          ],
    [snapshot]
  )
  const rows = useMemo(() => {
    const rows = snapshot.data.map((row, index) => ({ row, index }))
    if (sort)
      rows.sort((a, b) => {
        const left = a.row[sort.key],
          right = b.row[sort.key]
        if (left === null || right === null)
          return left === right ? a.index - b.index : left === null ? 1 : -1
        const comparison =
          typeof left === "number" && typeof right === "number"
            ? left - right
            : typeof left === "boolean" && typeof right === "boolean"
              ? Number(left) - Number(right)
              : String(left).localeCompare(String(right))
        return (sort.descending ? -comparison : comparison) || a.index - b.index
      })
    return rows
  }, [snapshot, sort])
  const sortedColumn = columns.find((column) => column.key === sort?.key)
  return (
    <div>
      <div
        className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
        aria-live="polite"
      >
        <span>
          {sort
            ? `Sorted by ${sortedColumn?.label}, ${sort.descending ? "descending" : "ascending"}. Nulls last. Saved order unchanged.`
            : "Supplied row order. Null means no value supplied."}
        </span>
        {sort && (
          <Button size="sm" variant="ghost" onClick={() => setSort(null)}>
            Reset order
          </Button>
        )}
      </div>
      <div
        className="max-h-96 overflow-auto rounded-md border focus-visible:outline-2 focus-visible:outline-ring"
        role="region"
        aria-label={`${snapshot.title} data`}
        tabIndex={0}
      >
        <Table>
          <TableCaption>
            {snapshot.title}: {snapshot.data.length} rows. Null cells are shown
            as “No value”.
          </TableCaption>
          <TableHeader>
            <TableRow>
              {columns.map((column) => (
                <TableHead
                  key={column.key}
                  scope="col"
                  aria-sort={
                    sort?.key === column.key
                      ? sort.descending
                        ? "descending"
                        : "ascending"
                      : "none"
                  }
                >
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setSort({
                        key: column.key,
                        descending:
                          sort?.key === column.key && !sort.descending,
                      })
                    }
                  >
                    {column.label}
                    {column.unit ? ` (${column.unit})` : ""}
                  </Button>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ row, index }) => (
              <TableRow key={index}>
                {columns.map((column) => (
                  <TableCell
                    key={column.key}
                    className="max-w-80 break-words whitespace-normal tabular-nums"
                  >
                    {row[column.key] === null ? (
                      <span className="text-muted-foreground">No value</span>
                    ) : typeof row[column.key] === "number" &&
                      column.valueType === "number" ? (
                      formatChartValue(column, row[column.key] as number)
                    ) : (
                      String(row[column.key])
                    )}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

const SnapshotPresentation = memo(function SnapshotPresentation({
  snapshot,
  artifactId,
  revision,
}: {
  snapshot: ArtifactSnapshot
  artifactId: string
  revision: number
}) {
  const [dataView, setDataView] = useState(snapshot.kind === "table")
  const [expanded, setExpanded] = useState(false)
  const choose = useContext(ArtifactChoiceContext)
  const alternatives = useMemo(
    () =>
      snapshot.kind === "ui_concept" ? uiConceptAlternatives(snapshot) : [],
    [snapshot]
  )
  // Shared by the inline view and the dialog so both show the same concept.
  const [selectedId, setSelectedId] = useState(alternatives[0]?.id)
  const selected =
    alternatives.find((alternative) => alternative.id === selectedId) ??
    alternatives[0]
  const multiple = snapshot.kind === "ui_concept" && !!snapshot.alternatives
  const [chosenId, setChosenId] = useState<string>()
  const chosen = !!selected && chosenId === selected.id
  const controls = (
    <div className="mb-3 flex flex-wrap gap-2">
      {snapshot.kind === "chart" && (
        <Button
          variant="outline"
          size="sm"
          aria-pressed={dataView}
          onClick={() => setDataView(!dataView)}
        >
          {dataView ? "Show chart" : "View data"}
        </Button>
      )}
      {snapshot.kind === "ui_concept" && choose && (
        <Button
          variant="outline"
          size="sm"
          disabled={chosen}
          onClick={() => {
            setChosenId(selected.id)
            choose({
              artifactId,
              revision,
              ...(multiple
                ? { alternative: { id: selected.id, label: selected.label } }
                : {}),
            })
          }}
        >
          {chosen
            ? "Added to your message"
            : multiple
              ? `Use “${selected.label}”`
              : "Use this direction"}
        </Button>
      )}
    </div>
  )
  const content = (inDialog = false) =>
    snapshot.kind === "visual" ? (
      <VisualAnswer snapshot={snapshot} />
    ) : snapshot.kind === "ui_concept" ? (
      <div className="space-y-2">
        {multiple && (
          <>
            <div
              role="group"
              aria-label="Concept alternatives"
              className="flex flex-wrap gap-1"
            >
              {alternatives.map((alternative, index) => (
                <Button
                  key={alternative.id}
                  type="button"
                  size="sm"
                  variant={
                    alternative.id === selected.id ? "secondary" : "ghost"
                  }
                  aria-pressed={alternative.id === selected.id}
                  onClick={() => setSelectedId(alternative.id)}
                >
                  {index + 1}. {alternative.label}
                </Button>
              ))}
            </div>
            {selected.description && (
              <p className="text-xs break-words text-muted-foreground">
                {selected.description}
              </p>
            )}
          </>
        )}
        {/* Keyed so switching alternatives starts from fresh demo state. */}
        <UiConceptPreview
          key={selected.id}
          concept={{
            ...selected,
            density: snapshot.density,
            typeScale: snapshot.typeScale,
          }}
          viewportPresets={inDialog}
        />
      </div>
    ) : dataView ? (
      <SnapshotData snapshot={snapshot} />
    ) : snapshot.kind === "chart" ? (
      <SnapshotChart snapshot={snapshot} />
    ) : null
  return (
    <>
      <div className="flex items-start justify-between gap-2">
        {controls}
        <Dialog open={expanded} onOpenChange={setExpanded}>
          <DialogTrigger asChild>
            <Button variant="ghost" size="sm">
              Expand
            </Button>
          </DialogTrigger>
          <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-5xl">
            <DialogTitle className="pr-8 break-words">
              {snapshot.title}
            </DialogTitle>
            <DialogDescription className="break-words">
              {snapshotDescription(snapshot)}
            </DialogDescription>
            {snapshot.kind !== "ui_concept" && snapshot.source && (
              <p className="text-xs break-words text-muted-foreground">
                Source: {snapshot.source}
              </p>
            )}
            {snapshot.kind !== "ui_concept" && snapshot.dataAsOf && (
              <p className="text-xs break-words text-muted-foreground">
                Data as of: {snapshot.dataAsOf}
              </p>
            )}
            {snapshot.kind === "chart" && snapshot.unit && (
              <p className="text-xs text-muted-foreground">
                Unit: {snapshot.unit}
              </p>
            )}
            {controls}
            {expanded && content(true)}
          </DialogContent>
        </Dialog>
      </div>
      {content()}
    </>
  )
})
