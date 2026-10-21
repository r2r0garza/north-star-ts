export const ARTIFACT_LIMITS = {
  rows: 1000,
  series: 12,
  columns: 24,
  key: 64,
  label: 200,
  description: 2000,
  cell: 500,
  bytes: 256 * 1024,
  conversationRevisions: 100,
  conversationBytes: 8 * 1024 * 1024,
} as const

export type ArtifactNumberFormat = "number" | "integer" | "percent"
export interface ChartSnapshot {
  kind: "chart"
  schemaVersion: 1
  title: string
  description?: string
  source?: string
  dataAsOf?: string
  chartKind: "line" | "bar" | "area"
  xKey: string
  unit?: string
  numberFormat?: ArtifactNumberFormat
  series: Array<{ key: string; label: string }>
  data: Array<Record<string, string | number | null>>
}

export interface TableColumn {
  key: string
  label: string
  valueType: "string" | "number" | "boolean"
  numberFormat?: ArtifactNumberFormat
  unit?: string
}
export interface TableSnapshot {
  kind: "table"
  schemaVersion: 1
  title: string
  description?: string
  source?: string
  dataAsOf?: string
  columns: TableColumn[]
  data: Array<Record<string, string | number | boolean | null>>
}
export type ConversationArtifact = ChartSnapshot | TableSnapshot
export interface ArtifactRevisionInput {
  artifactId?: string
  expectedBaseRevision?: number
}
export type ArtifactPresentation = ConversationArtifact & ArtifactRevisionInput
export interface ArtifactReference {
  schemaVersion: 1
  artifactId: string
  revision: number
  kind: ConversationArtifact["kind"]
  title: string
  rowCount: number
}
export interface ArtifactEnvelope {
  schemaVersion: 1
  conversationId: string
  invocationId: string
  reference: ArtifactReference
  snapshot: ConversationArtifact
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error(`${path} must be a plain object.`)
  return value as Record<string, unknown>
}
function fields(
  value: Record<string, unknown>,
  allowed: string[],
  path: string
): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      throw new Error(`${path}: unsupported field ${key.slice(0, 64)}.`)
}
function text(value: unknown, path: string, limit: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit)
    throw new Error(
      `${path} must be nonempty text of at most ${limit} characters.`
    )
  return value
}
function key(value: unknown, path: string): string {
  const result = text(value, path, ARTIFACT_LIMITS.key)
  if (
    !/^[A-Za-z][A-Za-z0-9_]*$/.test(result) ||
    ["__proto__", "constructor", "prototype"].includes(result)
  )
    throw new Error(
      `${path} must be a safe alphanumeric data key (starting with a letter).`
    )
  return result
}

export function validateChartSnapshot(input: unknown): ChartSnapshot {
  const value = object(input, "chart")
  fields(
    value,
    [
      "kind",
      "schemaVersion",
      "title",
      "description",
      "source",
      "dataAsOf",
      "chartKind",
      "xKey",
      "unit",
      "numberFormat",
      "series",
      "data",
    ],
    "chart"
  )
  if (value.kind !== undefined && value.kind !== "chart")
    throw new Error("Unsupported artifact kind.")
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1)
    throw new Error("Unsupported artifact schema version.")
  const title = text(value.title, "title", ARTIFACT_LIMITS.label)
  if (!["line", "bar", "area"].includes(value.chartKind as string))
    throw new Error("chartKind must be line, bar or area.")
  const xKey = key(value.xKey, "xKey")
  if (
    !Array.isArray(value.series) ||
    !value.series.length ||
    value.series.length > ARTIFACT_LIMITS.series
  )
    throw new Error(`Provide 1–${ARTIFACT_LIMITS.series} numeric series.`)
  const keys = new Set([xKey])
  const series = value.series.map((item, index) => {
    const s = object(item, `series[${index}]`)
    fields(s, ["key", "label"], "series")
    const k = key(s.key, "series.key")
    if (keys.has(k))
      throw new Error("Declared keys must be unique, including xKey.")
    keys.add(k)
    return {
      key: k,
      label: text(s.label, "series.label", ARTIFACT_LIMITS.label),
    }
  })
  if (!Array.isArray(value.data) || value.data.length > ARTIFACT_LIMITS.rows)
    throw new Error(
      `data must have at most ${ARTIFACT_LIMITS.rows} rows; aggregate before presenting.`
    )
  const data = value.data.map((item, index) => {
    const row = object(item, `data[${index}]`)
    fields(row, [...keys], `data[${index}]`)
    if (!Object.hasOwn(row, xKey))
      throw new Error(`data[${index}] is missing xKey.`)
    const category = row[xKey]
    if (
      !(
        typeof category === "string" && category.length <= ARTIFACT_LIMITS.cell
      ) &&
      !(typeof category === "number" && Number.isFinite(category))
    )
      throw new Error(
        `data[${index}].${xKey} must be a string or finite number.`
      )
    const copy: Record<string, string | number | null> = {
      [xKey]: category as string | number,
    }
    for (const s of series) {
      if (!Object.hasOwn(row, s.key))
        throw new Error(
          `data[${index}].${s.key} is missing; use explicit null for a gap.`
        )
      const n = row[s.key]
      if (n !== null && (typeof n !== "number" || !Number.isFinite(n)))
        throw new Error(
          `data[${index}].${s.key} must be finite numeric data or null.`
        )
      copy[s.key] = n as number | null
    }
    return copy
  })
  const snapshot: ChartSnapshot = {
    kind: "chart",
    schemaVersion: 1,
    title,
    chartKind: value.chartKind as ChartSnapshot["chartKind"],
    xKey,
    series,
    data,
  }
  for (const field of ["description", "source", "dataAsOf", "unit"] as const)
    if (value[field] !== undefined)
      snapshot[field] = text(
        value[field],
        field,
        field === "description"
          ? ARTIFACT_LIMITS.description
          : ARTIFACT_LIMITS.label
      )
  if (value.numberFormat !== undefined) {
    if (
      !["number", "integer", "percent"].includes(value.numberFormat as string)
    )
      throw new Error("Unsupported numberFormat.")
    if (
      value.numberFormat === "percent" &&
      value.unit !== undefined &&
      value.unit !== "%"
    )
      throw new Error(
        "percent format only supports unit % (values are fractions)."
      )
    snapshot.numberFormat = value.numberFormat as ArtifactNumberFormat
  }
  if (
    new TextEncoder().encode(JSON.stringify(snapshot)).length >
    ARTIFACT_LIMITS.bytes
  )
    throw new Error(
      `Chart exceeds ${ARTIFACT_LIMITS.bytes} serialized bytes; aggregate before presenting.`
    )
  return snapshot
}

export function artifactAcknowledgement(reference: ArtifactReference): string {
  return JSON.stringify({ ...reference, status: "saved_for_presentation" })
}

export function validateTableSnapshot(input: unknown): TableSnapshot {
  const value = object(input, "table")
  fields(
    value,
    [
      "kind",
      "schemaVersion",
      "title",
      "description",
      "source",
      "dataAsOf",
      "columns",
      "data",
    ],
    "table"
  )
  if (value.kind !== undefined && value.kind !== "table")
    throw new Error("Unsupported artifact kind.")
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1)
    throw new Error("Unsupported artifact schema version.")
  if (
    !Array.isArray(value.columns) ||
    !value.columns.length ||
    value.columns.length > ARTIFACT_LIMITS.columns
  )
    throw new Error(`Provide 1–${ARTIFACT_LIMITS.columns} columns.`)
  const keys = new Set<string>()
  const columns: TableColumn[] = value.columns.map((item) => {
    const column = object(item, "column")
    fields(
      column,
      ["key", "label", "valueType", "numberFormat", "unit"],
      "column"
    )
    const k = key(column.key, "column.key")
    if (keys.has(k)) throw new Error("Declared keys must be unique.")
    keys.add(k)
    if (!["string", "number", "boolean"].includes(column.valueType as string))
      throw new Error("Unsupported column valueType.")
    const result: TableColumn = {
      key: k,
      label: text(column.label, "column.label", ARTIFACT_LIMITS.label),
      valueType: column.valueType as TableColumn["valueType"],
    }
    if (column.numberFormat !== undefined || column.unit !== undefined) {
      if (column.valueType !== "number")
        throw new Error("Only numeric columns support numberFormat and unit.")
      if (column.numberFormat !== undefined) {
        if (
          !["number", "integer", "percent"].includes(
            column.numberFormat as string
          )
        )
          throw new Error("Unsupported numberFormat.")
        result.numberFormat = column.numberFormat as ArtifactNumberFormat
      }
      if (column.unit !== undefined)
        result.unit = text(column.unit, "column.unit", ARTIFACT_LIMITS.label)
      if (
        result.numberFormat === "percent" &&
        result.unit !== undefined &&
        result.unit !== "%"
      )
        throw new Error(
          "percent format only supports unit % (values are fractions)."
        )
    }
    return result
  })
  if (!Array.isArray(value.data) || value.data.length > ARTIFACT_LIMITS.rows)
    throw new Error(
      `data must have at most ${ARTIFACT_LIMITS.rows} rows; aggregate before presenting.`
    )
  const data = value.data.map((item, index) => {
    const row = object(item, `data[${index}]`)
    fields(row, [...keys], `data[${index}]`)
    const copy: TableSnapshot["data"][number] = {}
    for (const column of columns) {
      if (!Object.hasOwn(row, column.key))
        throw new Error(
          `data[${index}].${column.key} is missing; use explicit null.`
        )
      const cell = row[column.key]
      if (
        cell !== null &&
        (typeof cell !== column.valueType ||
          (typeof cell === "number" && !Number.isFinite(cell)) ||
          (typeof cell === "string" && cell.length > ARTIFACT_LIMITS.cell))
      )
        throw new Error(
          `data[${index}].${column.key} must be ${column.valueType} or null (text at most ${ARTIFACT_LIMITS.cell} characters).`
        )
      copy[column.key] = cell as string | number | boolean | null
    }
    return copy
  })
  const snapshot: TableSnapshot = {
    kind: "table",
    schemaVersion: 1,
    title: text(value.title, "title", ARTIFACT_LIMITS.label),
    columns,
    data,
  }
  for (const field of ["description", "source", "dataAsOf"] as const)
    if (value[field] !== undefined)
      snapshot[field] = text(
        value[field],
        field,
        field === "description"
          ? ARTIFACT_LIMITS.description
          : ARTIFACT_LIMITS.label
      )
  if (
    new TextEncoder().encode(JSON.stringify(snapshot)).length >
    ARTIFACT_LIMITS.bytes
  )
    throw new Error(
      "Table exceeds serialized byte limit; aggregate before presenting."
    )
  return snapshot
}

export function validateArtifactSnapshot(input: unknown): ConversationArtifact {
  const value = object(input, "artifact")
  if (value.kind === "chart") return validateChartSnapshot(value)
  if (value.kind === "table") return validateTableSnapshot(value)
  throw new Error("Unsupported artifact kind.")
}

export function validateArtifactPresentation(
  input: unknown,
  kind: ConversationArtifact["kind"]
): ArtifactPresentation {
  const value = object(input, kind)
  const { artifactId, expectedBaseRevision, ...spec } = value
  const snapshot =
    kind === "chart" ? validateChartSnapshot(spec) : validateTableSnapshot(spec)
  if (artifactId === undefined && expectedBaseRevision === undefined)
    return snapshot
  if (
    typeof artifactId !== "string" ||
    !/^[a-zA-Z0-9-]{1,128}$/.test(artifactId) ||
    !Number.isSafeInteger(expectedBaseRevision) ||
    (expectedBaseRevision as number) < 1
  )
    throw new Error(
      "Revisions require artifactId and a positive expectedBaseRevision together."
    )
  return {
    ...snapshot,
    artifactId,
    expectedBaseRevision: expectedBaseRevision as number,
  }
}
