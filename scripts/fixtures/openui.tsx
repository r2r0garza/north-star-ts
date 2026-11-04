import { useState } from "react"
import { createRoot } from "react-dom/client"
import "../../src/renderer/src/globals.css"
import { StaticAnswer, Snapshot, concept } from "./openui-library"
import { UiConceptPreview } from "../../src/renderer/src/components/ui-concept-preview"
import { Button } from "../../src/renderer/src/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "../../src/renderer/src/components/ui/dialog"

export const sources = {
  metrics:
    'root = Row([Metric("Final completion rate",0.75,"percent"),Metric("Observed periods",2,"integer")]);',
  mixed:
    'root = Stack([Text("Completion rose across two observed periods. The missing observation is not zero."),Row([Metric("Final completion rate",0.75,"percent"),Metric("Observed periods",2,"integer")]),Chart("completion"),DataTable("supporting")]);',
  comparison:
    'root = Tabs([Tab("Overview",[Row([Card("First period",[Metric("Completion",0.25,"percent")]),Card("Final period",[Metric("Completion",0.75,"percent")])])]),Tab("Evidence",[Chart("completion"),DataTable("supporting")])]);',
  concept:
    'root = Tabs([Tab("Compact",[Concept("compact")]),Tab("Grouped",[Concept("card")])]);',
  "large-and-empty":
    'root = Stack([Chart("large"),DataTable("large-table"),DataTable("empty")]);',
  "prose-control": "",
  rejected: "root = Text(@Sum([1,2]));",
}

function Answer({ id }: { id: keyof typeof sources }) {
  if (id === "prose-control")
    return (
      <p>
        Missing observations mean no value was supplied. Zero is an observed
        value. Treating the two as equivalent would change the evidence.
      </p>
    )
  return <StaticAnswer source={sources[id]} />
}
function Baseline({ id }: { id: keyof typeof sources }) {
  if (id === "mixed")
    return (
      <div className="space-y-6">
        <p>
          Final rate 75%; two observed periods. Current tools require separate
          artifacts.
        </p>
        <Snapshot id="completion" />
        <Snapshot id="supporting" />
      </div>
    )
  if (id === "large-and-empty")
    return (
      <div className="space-y-6">
        <Snapshot id="large" />
        <Snapshot id="large-table" />
        <Snapshot id="empty" />
      </div>
    )
  if (id === "concept")
    return <UiConceptPreview concept={{ ...concept, tree: concept.tree! }} />
  if (id === "comparison")
    return (
      <p>
        Cards and tabs are supported in present_ui, but embedded analytical
        charts are not. No equivalent composed baseline exists.
      </p>
    )
  if (id === "metrics")
    return <p>Final completion rate: 75%. Observed periods: 2.</p>
  return <Answer id="prose-control" />
}
function App() {
  const [id, setId] = useState<keyof typeof sources>("mixed")
  const [dark, setDark] = useState(false)
  const [revision, setRevision] = useState(1)
  return (
    <main className="mx-auto max-w-6xl space-y-6 p-5">
      <header className="space-y-3">
        <h1 className="text-xl font-semibold">OpenUI composition comparison</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Development fixture. Synthetic snapshot data, not observed findings.
          No persistence, tool offering or host actions.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <label>
            Fixture{" "}
            <select
              className="ml-2 rounded border bg-background p-2"
              aria-label="Fixture"
              value={id}
              onChange={(e) => {
                setId(e.target.value as keyof typeof sources)
                setRevision(1)
              }}
            >
              {Object.keys(sources).map((key) => (
                <option key={key}>{key}</option>
              ))}
            </select>
          </label>
          <Button
            variant="outline"
            onClick={() => {
              document.documentElement.classList.toggle("dark", !dark)
              setDark(!dark)
            }}
          >
            {dark ? "Light theme" : "Dark theme"}
          </Button>
          <Button variant="outline" onClick={() => setRevision(revision + 1)}>
            Reset local state
          </Button>
        </div>
      </header>
      <div className="flex flex-wrap items-start gap-6">
        <section
          className="w-[360px] max-w-full min-w-0 space-y-4"
          aria-label="Current baseline"
        >
          <h2 className="font-medium">Current tools</h2>
          <div className="space-y-4 rounded-lg border p-4">
            <Baseline key={`${id}-${revision}`} id={id} />
          </div>
        </section>
        <section
          className="w-[360px] max-w-full min-w-0 space-y-4"
          aria-label="OpenUI comparison"
        >
          <h2 className="font-medium">OpenUI static subset</h2>
          <p className="text-xs text-muted-foreground">
            Fixture revision {revision}; local display state only.
          </p>
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline">Expand comparison</Button>
            </DialogTrigger>
            <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-4xl">
              <DialogTitle>Expanded OpenUI comparison</DialogTitle>
              <DialogDescription>
                Synthetic data. Display-only, no artifact saved.
              </DialogDescription>
              <Answer key={`${id}-${revision}-expanded`} id={id} />
            </DialogContent>
          </Dialog>
          <div
            key={`${id}-${revision}`}
            className="rounded-lg border p-4"
            onKeyDown={(event) => {
              if (event.key !== "Escape") event.stopPropagation()
            }}
          >
            <Answer id={id} />
          </div>
        </section>
      </div>
    </main>
  )
}
createRoot(document.getElementById("root")!).render(<App />)
