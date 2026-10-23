import {
  createContext,
  useContext,
  useId,
  useState,
  type KeyboardEvent,
} from "react"
import {
  UI_INITIAL_STATE,
  type UiConceptScreens,
  type UiConceptSnapshot,
  type UiControlNode,
  type UiNode,
} from "../../../shared/conversation-artifacts"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

// Literal class maps: tokens from the validated tree select host classes; no
// supplied text ever becomes a class, style, id or prop.
const GAP = { none: "gap-0", sm: "gap-2", md: "gap-4", lg: "gap-6" }
const ALIGN = {
  start: "items-start",
  center: "items-center",
  end: "items-end",
  stretch: "items-stretch",
}
const JUSTIFY = {
  start: "justify-start",
  center: "justify-center",
  end: "justify-end",
  between: "justify-between",
}
const COLUMNS = {
  1: "grid-cols-1",
  2: "grid-cols-1 @md/concept:grid-cols-2",
  3: "grid-cols-1 @md/concept:grid-cols-3",
  4: "grid-cols-2 @md/concept:grid-cols-4",
}
const TEXT = {
  body: "text-sm",
  muted: "text-sm text-muted-foreground",
  heading: "text-lg font-semibold",
  subheading: "text-base font-medium",
}

function Children({ nodes }: { nodes: UiNode[] }) {
  return nodes.map((node, index) => <Node key={index} node={node} />)
}

function Control({ control, id }: { control: UiControlNode; id: string }) {
  switch (control.type) {
    case "input":
      return (
        <Input
          id={id}
          type={control.inputType ?? "text"}
          placeholder={control.placeholder}
          defaultValue={control.defaultValue}
          autoComplete="off"
        />
      )
    case "select":
      return (
        <NativeSelect id={id} defaultValue={control.defaultValue}>
          {control.options.map((option) => (
            <NativeSelectOption key={option} value={option}>
              {option}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      )
    case "switch":
      return <Switch id={id} defaultChecked={control.defaultChecked} />
  }
}

function ConceptField({ node }: { node: Extract<UiNode, { type: "field" }> }) {
  const id = useId()
  const horizontal = node.orientation === "horizontal"
  return (
    <Field orientation={horizontal ? "horizontal" : "vertical"}>
      <div className={cn("flex flex-col gap-1", horizontal && "flex-1")}>
        <FieldLabel htmlFor={id}>{node.label}</FieldLabel>
        {node.description && (
          <FieldDescription>{node.description}</FieldDescription>
        )}
      </div>
      <Control control={node.control} id={id} />
    </Field>
  )
}

function Node({ node }: { node: UiNode }) {
  switch (node.type) {
    case "stack":
      return (
        <div
          className={cn(
            "flex min-w-0 flex-col",
            GAP[node.gap ?? "md"],
            ALIGN[node.align ?? "stretch"]
          )}
        >
          <Children nodes={node.children} />
        </div>
      )
    case "row":
      return (
        <div
          className={cn(
            "flex min-w-0 flex-row",
            GAP[node.gap ?? "md"],
            ALIGN[node.align ?? "center"],
            JUSTIFY[node.justify ?? "start"],
            node.wrap && "flex-wrap"
          )}
        >
          <Children nodes={node.children} />
        </div>
      )
    case "grid":
      return (
        <div
          className={cn(
            "grid min-w-0",
            COLUMNS[node.columns],
            GAP[node.gap ?? "md"]
          )}
        >
          <Children nodes={node.children} />
        </div>
      )
    case "text": {
      const className = cn(
        "break-words",
        TEXT[node.role ?? "body"],
        node.emphasis === "strong" && "font-semibold"
      )
      // h3 is the artifact title, so concept headings start one level below.
      if (node.role === "heading")
        return <h4 className={className}>{node.text}</h4>
      if (node.role === "subheading")
        return <h5 className={className}>{node.text}</h5>
      return <p className={className}>{node.text}</p>
    }
    case "separator":
      return <Separator />
    case "card":
      return (
        <Card className={cn("min-w-0", node.surface === "muted" && "bg-muted")}>
          {(node.title || node.description) && (
            <CardHeader>
              {node.title && <CardTitle>{node.title}</CardTitle>}
              {node.description && (
                <CardDescription>{node.description}</CardDescription>
              )}
            </CardHeader>
          )}
          {node.children.length > 0 && (
            <CardContent className="flex flex-col gap-4">
              <Children nodes={node.children} />
            </CardContent>
          )}
        </Card>
      )
    case "badge":
      return <Badge variant={node.variant}>{node.text}</Badge>
    case "button":
      return <ConceptButton node={node} />
    case "table":
      return (
        <div className="min-w-0 overflow-x-auto rounded-md border">
          <Table>
            {node.caption && <TableCaption>{node.caption}</TableCaption>}
            <TableHeader>
              <TableRow>
                {node.columns.map((column, index) => (
                  <TableHead key={index} scope="col">
                    {column}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {node.rows.map((row, r) => (
                <TableRow key={r}>
                  {row.map((cell, c) => (
                    <TableCell key={c}>{cell}</TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )
    case "field":
      return <ConceptField node={node} />
    case "tabs":
      return (
        <Tabs defaultValue="0" className="min-w-0">
          <TabsList>
            {node.tabs.map((tab, index) => (
              <TabsTrigger key={index} value={String(index)}>
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {node.tabs.map((tab, index) => (
            // Mounted while hidden so demo values survive switching tabs.
            <TabsContent
              key={index}
              value={String(index)}
              forceMount
              className="flex flex-col gap-4 data-[state=inactive]:hidden"
            >
              <Children nodes={tab.children} />
            </TabsContent>
          ))}
        </Tabs>
      )
  }
}

// Pure host reducer: only declared state ids are reachable; anything else is a
// no-op. Buttons never carry actions beyond this.
export function conceptStateAfter(
  concept: Pick<UiConceptScreens, "states">,
  current: string,
  goTo: string | undefined
): string {
  if (goTo === undefined) return current
  return goTo === UI_INITIAL_STATE ||
    concept.states?.some((state) => state.id === goTo)
    ? goTo
    : current
}

const NavigateContext = createContext<(goTo: string | undefined) => void>(
  () => {}
)

function ConceptButton({
  node,
}: {
  node: Extract<UiNode, { type: "button" }>
}) {
  const navigate = useContext(NavigateContext)
  return (
    <Button
      type="button"
      variant={node.variant}
      size={node.size}
      onClick={() => navigate(node.goTo)}
    >
      {node.text}
    </Button>
  )
}

// Scoped theme-variable overrides: Tailwind spacing/text utilities inside the
// concept resolve against these, so tokens rescale without touching app styles.
const DENSITY = {
  compact: "[--spacing:0.2rem]",
  comfortable: "",
  spacious: "[--spacing:0.3rem]",
}
const TYPE_SCALE = {
  sm: "[--text-sm:0.8125rem] [--text-base:0.9375rem] [--text-lg:1rem]",
  md: "",
  lg: "[--text-sm:0.9375rem] [--text-base:1.0625rem] [--text-lg:1.25rem]",
}
const VIEWPORTS = {
  fit: { label: "Fit", className: "" },
  mobile: { label: "Mobile", className: "max-w-[375px]" },
  tablet: { label: "Tablet", className: "max-w-[768px]" },
  desktop: { label: "Desktop", className: "w-[1024px] max-w-none" },
}

// Keys stay inside the concept so typing never reaches app-wide shortcuts;
// Escape still bubbles so a host dialog can close.
function containKeys(event: KeyboardEvent) {
  if (event.key !== "Escape") event.stopPropagation()
}

export function UiConceptPreview({
  concept,
  viewportPresets = false,
}: {
  concept: UiConceptScreens & Pick<UiConceptSnapshot, "density" | "typeScale">
  viewportPresets?: boolean
}) {
  const [current, setCurrent] = useState(UI_INITIAL_STATE)
  const [viewport, setViewport] = useState<keyof typeof VIEWPORTS>("fit")
  const state = concept.states?.find((s) => s.id === current)
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <p className="w-full">
          Visual reference only: built with North Star&apos;s own components and
          sample content, not your project&apos;s components. Controls are local
          demos and change nothing.
        </p>
        {concept.states && (
          <>
            <span aria-live="polite">
              Preview state: {state?.label ?? "Initial"}
            </span>
            {state && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setCurrent(UI_INITIAL_STATE)}
              >
                Reset preview
              </Button>
            )}
          </>
        )}
        {viewportPresets && (
          <div role="group" aria-label="Preview width" className="flex gap-1">
            {Object.entries(VIEWPORTS).map(([key, preset]) => (
              <Button
                key={key}
                type="button"
                size="sm"
                variant={viewport === key ? "secondary" : "ghost"}
                aria-pressed={viewport === key}
                onClick={() => setViewport(key as keyof typeof VIEWPORTS)}
              >
                {preset.label}
              </Button>
            ))}
          </div>
        )}
      </div>
      <div
        role="group"
        aria-label="UI concept preview"
        onKeyDown={containKeys}
        className={cn(
          "@container/concept mx-auto max-h-[36rem] overflow-auto rounded-md border bg-background p-4",
          VIEWPORTS[viewport].className,
          DENSITY[concept.density ?? "comfortable"],
          TYPE_SCALE[concept.typeScale ?? "md"]
        )}
      >
        <NavigateContext.Provider
          value={(goTo) =>
            setCurrent((value) => conceptStateAfter(concept, value, goTo))
          }
        >
          {/* Keyed so each screen starts with fresh demo state. */}
          <Node key={current} node={state?.tree ?? concept.tree} />
        </NavigateContext.Provider>
      </div>
    </div>
  )
}
