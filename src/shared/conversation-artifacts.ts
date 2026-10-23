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
// Declarative UI concept (PR116): host-rendered data, never code or raw props.
export const UI_CONCEPT_LIMITS = {
  nodes: 200,
  depth: 12,
  text: 500,
  options: 20,
  tabs: 6,
  tableColumns: 12,
  tableRows: 50,
  states: 8,
} as const
// The snapshot's own tree is always reachable under this state id.
export const UI_INITIAL_STATE = "initial"
export type UiGap = "none" | "sm" | "md" | "lg"
export type UiControlNode =
  | {
      type: "input"
      inputType?: "text" | "email" | "number" | "search"
      placeholder?: string
      defaultValue?: string
    }
  | { type: "select"; options: string[]; defaultValue?: string }
  | { type: "switch"; defaultChecked?: boolean }
export type UiNode =
  | {
      type: "stack"
      gap?: UiGap
      align?: "start" | "center" | "end" | "stretch"
      children: UiNode[]
    }
  | {
      type: "row"
      gap?: UiGap
      align?: "start" | "center" | "end" | "stretch"
      justify?: "start" | "center" | "end" | "between"
      wrap?: boolean
      children: UiNode[]
    }
  | { type: "grid"; columns: 1 | 2 | 3 | 4; gap?: UiGap; children: UiNode[] }
  | {
      type: "text"
      text: string
      role?: "heading" | "subheading" | "body" | "muted"
      emphasis?: "normal" | "strong"
    }
  | { type: "separator" }
  | {
      type: "card"
      title?: string
      description?: string
      surface?: "default" | "muted"
      children: UiNode[]
    }
  | {
      type: "badge"
      text: string
      variant?: "default" | "secondary" | "outline" | "destructive"
    }
  | {
      type: "button"
      text: string
      variant?: "default" | "secondary" | "outline" | "ghost" | "destructive"
      size?: "sm" | "default"
      goTo?: string
    }
  | { type: "table"; caption?: string; columns: string[]; rows: string[][] }
  | {
      type: "field"
      label: string
      description?: string
      orientation?: "vertical" | "horizontal"
      control: UiControlNode
    }
  | { type: "tabs"; tabs: Array<{ label: string; children: UiNode[] }> }
export interface UiConceptSnapshot {
  kind: "ui_concept"
  schemaVersion: 1
  title: string
  description?: string
  density?: "compact" | "comfortable" | "spacious"
  typeScale?: "sm" | "md" | "lg"
  tree: UiNode
  states?: Array<{ id: string; label: string; tree: UiNode }>
}
export type ConversationArtifact =
  | ChartSnapshot
  | TableSnapshot
  | UiConceptSnapshot
// Tool name → artifact kind; the single list every presentation seam checks.
export const PRESENTATION_TOOLS = {
  present_chart: "chart",
  present_table: "table",
  present_ui: "ui_concept",
} as const satisfies Record<string, ConversationArtifact["kind"]>
export function isPresentationTool(
  name: string | null | undefined
): name is keyof typeof PRESENTATION_TOOLS {
  return !!name && Object.hasOwn(PRESENTATION_TOOLS, name)
}
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

function choice<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string
): T | undefined {
  if (value === undefined) return undefined
  if (!allowed.includes(value as T))
    throw new Error(`${path} must be one of ${allowed.join(", ")}.`)
  return value as T
}
function uiText(value: unknown, path: string): string {
  return text(value, path, UI_CONCEPT_LIMITS.text)
}
// Copies only declared fields, so nothing unvalidated can reach a component.
function optional<T extends object>(target: T, extra: Record<string, unknown>) {
  for (const [k, v] of Object.entries(extra))
    if (v !== undefined) (target as Record<string, unknown>)[k] = v
  return target
}
const GAPS = ["none", "sm", "md", "lg"] as const
const ALIGN = ["start", "center", "end", "stretch"] as const

export function validateUiConceptSnapshot(input: unknown): UiConceptSnapshot {
  const value = object(input, "ui_concept")
  fields(
    value,
    [
      "kind",
      "schemaVersion",
      "title",
      "description",
      "density",
      "typeScale",
      "tree",
      "states",
    ],
    "ui_concept"
  )
  if (value.kind !== undefined && value.kind !== "ui_concept")
    throw new Error("Unsupported artifact kind.")
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1)
    throw new Error("Unsupported artifact schema version.")
  let nodes = 0
  const targets: Array<{ goTo: string; path: string }> = []
  const children = (list: unknown, path: string, depth: number) => {
    if (!Array.isArray(list))
      throw new Error(`${path}.children must be an array.`)
    return list.map((item, i) => node(item, `${path}.children[${i}]`, depth))
  }
  const control = (input: unknown, path: string): UiControlNode => {
    const c = object(input, path)
    if (++nodes > UI_CONCEPT_LIMITS.nodes)
      throw new Error(`Tree exceeds ${UI_CONCEPT_LIMITS.nodes} nodes.`)
    if (c.type === "input") {
      fields(c, ["type", "inputType", "placeholder", "defaultValue"], path)
      return optional({ type: "input" } as UiControlNode, {
        inputType: choice(
          c.inputType,
          ["text", "email", "number", "search"],
          `${path}.inputType`
        ),
        placeholder:
          c.placeholder === undefined
            ? undefined
            : uiText(c.placeholder, `${path}.placeholder`),
        defaultValue:
          c.defaultValue === undefined
            ? undefined
            : uiText(c.defaultValue, `${path}.defaultValue`),
      })
    }
    if (c.type === "select") {
      fields(c, ["type", "options", "defaultValue"], path)
      if (
        !Array.isArray(c.options) ||
        !c.options.length ||
        c.options.length > UI_CONCEPT_LIMITS.options
      )
        throw new Error(
          `${path}.options must list 1–${UI_CONCEPT_LIMITS.options} choices.`
        )
      const options = c.options.map((o, i) =>
        uiText(o, `${path}.options[${i}]`)
      )
      if (new Set(options).size !== options.length)
        throw new Error(`${path}.options must be unique.`)
      if (
        c.defaultValue !== undefined &&
        !options.includes(c.defaultValue as string)
      )
        throw new Error(`${path}.defaultValue must be one of its options.`)
      return optional({ type: "select", options } as UiControlNode, {
        defaultValue: c.defaultValue,
      })
    }
    if (c.type === "switch") {
      fields(c, ["type", "defaultChecked"], path)
      if (
        c.defaultChecked !== undefined &&
        typeof c.defaultChecked !== "boolean"
      )
        throw new Error(`${path}.defaultChecked must be boolean.`)
      return optional({ type: "switch" } as UiControlNode, {
        defaultChecked: c.defaultChecked,
      })
    }
    throw new Error(`${path}: field control must be input, select or switch.`)
  }
  const node = (input: unknown, path: string, depth: number): UiNode => {
    if (depth > UI_CONCEPT_LIMITS.depth)
      throw new Error(`Tree exceeds nesting depth ${UI_CONCEPT_LIMITS.depth}.`)
    const n = object(input, path)
    if (++nodes > UI_CONCEPT_LIMITS.nodes)
      throw new Error(`Tree exceeds ${UI_CONCEPT_LIMITS.nodes} nodes.`)
    const next = depth + 1
    switch (n.type) {
      case "stack":
        fields(n, ["type", "gap", "align", "children"], path)
        return optional(
          {
            type: "stack",
            children: children(n.children, path, next),
          } as UiNode,
          {
            gap: choice(n.gap, GAPS, `${path}.gap`),
            align: choice(n.align, ALIGN, `${path}.align`),
          }
        )
      case "row":
        fields(n, ["type", "gap", "align", "justify", "wrap", "children"], path)
        if (n.wrap !== undefined && typeof n.wrap !== "boolean")
          throw new Error(`${path}.wrap must be boolean.`)
        return optional(
          { type: "row", children: children(n.children, path, next) } as UiNode,
          {
            gap: choice(n.gap, GAPS, `${path}.gap`),
            align: choice(n.align, ALIGN, `${path}.align`),
            justify: choice(
              n.justify,
              ["start", "center", "end", "between"],
              `${path}.justify`
            ),
            wrap: n.wrap,
          }
        )
      case "grid":
        fields(n, ["type", "columns", "gap", "children"], path)
        if (![1, 2, 3, 4].includes(n.columns as number))
          throw new Error(`${path}.columns must be 1, 2, 3 or 4.`)
        return optional(
          {
            type: "grid",
            columns: n.columns,
            children: children(n.children, path, next),
          } as UiNode,
          { gap: choice(n.gap, GAPS, `${path}.gap`) }
        )
      case "text":
        fields(n, ["type", "text", "role", "emphasis"], path)
        return optional(
          { type: "text", text: uiText(n.text, `${path}.text`) } as UiNode,
          {
            role: choice(
              n.role,
              ["heading", "subheading", "body", "muted"],
              `${path}.role`
            ),
            emphasis: choice(
              n.emphasis,
              ["normal", "strong"],
              `${path}.emphasis`
            ),
          }
        )
      case "separator":
        fields(n, ["type"], path)
        return { type: "separator" }
      case "card":
        fields(n, ["type", "title", "description", "surface", "children"], path)
        return optional(
          {
            type: "card",
            children: children(n.children ?? [], path, next),
          } as UiNode,
          {
            title:
              n.title === undefined
                ? undefined
                : uiText(n.title, `${path}.title`),
            description:
              n.description === undefined
                ? undefined
                : uiText(n.description, `${path}.description`),
            surface: choice(n.surface, ["default", "muted"], `${path}.surface`),
          }
        )
      case "badge":
        fields(n, ["type", "text", "variant"], path)
        return optional(
          { type: "badge", text: uiText(n.text, `${path}.text`) } as UiNode,
          {
            variant: choice(
              n.variant,
              ["default", "secondary", "outline", "destructive"],
              `${path}.variant`
            ),
          }
        )
      case "button":
        fields(n, ["type", "text", "variant", "size", "goTo"], path)
        if (n.goTo !== undefined)
          targets.push({ goTo: key(n.goTo, `${path}.goTo`), path })
        return optional(
          { type: "button", text: uiText(n.text, `${path}.text`) } as UiNode,
          {
            variant: choice(
              n.variant,
              ["default", "secondary", "outline", "ghost", "destructive"],
              `${path}.variant`
            ),
            size: choice(n.size, ["sm", "default"], `${path}.size`),
            goTo: n.goTo,
          }
        )
      case "table": {
        fields(n, ["type", "caption", "columns", "rows"], path)
        if (
          !Array.isArray(n.columns) ||
          !n.columns.length ||
          n.columns.length > UI_CONCEPT_LIMITS.tableColumns
        )
          throw new Error(
            `${path}.columns must list 1–${UI_CONCEPT_LIMITS.tableColumns} headers.`
          )
        const columns = n.columns.map((c, i) =>
          uiText(c, `${path}.columns[${i}]`)
        )
        if (
          !Array.isArray(n.rows) ||
          n.rows.length > UI_CONCEPT_LIMITS.tableRows
        )
          throw new Error(
            `${path}.rows must have at most ${UI_CONCEPT_LIMITS.tableRows} rows.`
          )
        const rows = n.rows.map((row, r) => {
          if (!Array.isArray(row) || row.length !== columns.length)
            throw new Error(`${path}.rows[${r}] must have one cell per column.`)
          // Empty cells are allowed in a mockup table.
          return row.map((cell, c) => {
            if (
              typeof cell !== "string" ||
              cell.length > UI_CONCEPT_LIMITS.text
            )
              throw new Error(`${path}.rows[${r}][${c}] must be short text.`)
            return cell
          })
        })
        return optional({ type: "table", columns, rows } as UiNode, {
          caption:
            n.caption === undefined
              ? undefined
              : uiText(n.caption, `${path}.caption`),
        })
      }
      case "field":
        fields(
          n,
          ["type", "label", "description", "orientation", "control"],
          path
        )
        return optional(
          {
            type: "field",
            label: uiText(n.label, `${path}.label`),
            control: control(n.control, `${path}.control`),
          } as UiNode,
          {
            description:
              n.description === undefined
                ? undefined
                : uiText(n.description, `${path}.description`),
            orientation: choice(
              n.orientation,
              ["vertical", "horizontal"],
              `${path}.orientation`
            ),
          }
        )
      case "tabs": {
        fields(n, ["type", "tabs"], path)
        if (
          !Array.isArray(n.tabs) ||
          n.tabs.length < 2 ||
          n.tabs.length > UI_CONCEPT_LIMITS.tabs
        )
          throw new Error(
            `${path}.tabs must list 2–${UI_CONCEPT_LIMITS.tabs} tabs.`
          )
        const tabs = n.tabs.map((item, i) => {
          const tab = object(item, `${path}.tabs[${i}]`)
          fields(tab, ["label", "children"], `${path}.tabs[${i}]`)
          return {
            label: uiText(tab.label, `${path}.tabs[${i}].label`),
            children: children(tab.children, `${path}.tabs[${i}]`, next),
          }
        })
        if (new Set(tabs.map((t) => t.label)).size !== tabs.length)
          throw new Error(`${path}.tabs labels must be unique.`)
        return { type: "tabs", tabs }
      }
      default:
        throw new Error(
          `${path}: unsupported node type ${String(n.type).slice(0, 32)}. Controls (input, select, switch) belong inside a field.`
        )
    }
  }
  const snapshot: UiConceptSnapshot = {
    kind: "ui_concept",
    schemaVersion: 1,
    title: text(value.title, "title", ARTIFACT_LIMITS.label),
    tree: node(value.tree, "tree", 1),
  }
  if (value.description !== undefined)
    snapshot.description = text(
      value.description,
      "description",
      ARTIFACT_LIMITS.description
    )
  optional(snapshot, {
    density: choice(
      value.density,
      ["compact", "comfortable", "spacious"],
      "density"
    ),
    typeScale: choice(value.typeScale, ["sm", "md", "lg"], "typeScale"),
  })
  if (value.states !== undefined) {
    if (
      !Array.isArray(value.states) ||
      !value.states.length ||
      value.states.length > UI_CONCEPT_LIMITS.states
    )
      throw new Error(
        `states must list 1–${UI_CONCEPT_LIMITS.states} alternate screens.`
      )
    const ids = new Set([UI_INITIAL_STATE])
    snapshot.states = value.states.map((item, i) => {
      const path = `states[${i}]`
      const state = object(item, path)
      fields(state, ["id", "label", "tree"], path)
      const id = key(state.id, `${path}.id`)
      if (ids.has(id))
        throw new Error(
          `${path}.id must be unique and not "${UI_INITIAL_STATE}".`
        )
      ids.add(id)
      return {
        id,
        label: text(state.label, `${path}.label`, ARTIFACT_LIMITS.label),
        tree: node(state.tree, `${path}.tree`, 1),
      }
    })
  }
  const stateIds = new Set([
    UI_INITIAL_STATE,
    ...(snapshot.states ?? []).map((state) => state.id),
  ])
  for (const target of targets)
    if (!stateIds.has(target.goTo))
      throw new Error(
        `${target.path}.goTo must name a declared state (or "${UI_INITIAL_STATE}").`
      )
  if (
    new TextEncoder().encode(JSON.stringify(snapshot)).length >
    ARTIFACT_LIMITS.bytes
  )
    throw new Error("UI concept exceeds serialized byte limit.")
  return snapshot
}

// Host-authored composer note for "Use this direction". The tag marks it as a
// UI selection rather than typed prose; it names an exact revision only.
export function uiConceptChoiceNote(artifactId: string, revision: number) {
  return `<user_design_choice artifact_id=${JSON.stringify(artifactId)} revision=${JSON.stringify(revision)}>Chose this UI concept direction via the "Use this direction" button.</user_design_choice>`
}

const VALIDATORS: {
  [K in ConversationArtifact["kind"]]: (input: unknown) => ConversationArtifact
} = {
  chart: validateChartSnapshot,
  table: validateTableSnapshot,
  ui_concept: validateUiConceptSnapshot,
}

export function validateArtifactSnapshot(input: unknown): ConversationArtifact {
  const value = object(input, "artifact")
  if (!Object.hasOwn(VALIDATORS, value.kind as string))
    throw new Error("Unsupported artifact kind.")
  return VALIDATORS[value.kind as ConversationArtifact["kind"]](value)
}

// Rows for data artifacts; rendered nodes are not rows, so concepts report 0.
export function artifactRowCount(snapshot: ConversationArtifact): number {
  return snapshot.kind === "ui_concept" ? 0 : snapshot.data.length
}

export function validateArtifactPresentation(
  input: unknown,
  kind: ConversationArtifact["kind"]
): ArtifactPresentation {
  const value = object(input, kind)
  const { artifactId, expectedBaseRevision, ...spec } = value
  const snapshot = VALIDATORS[kind](spec)
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
