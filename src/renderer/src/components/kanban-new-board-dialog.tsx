import { useState } from "react"
import { FolderOpen, Plus, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Spinner } from "@/components/ui/spinner"
import type { KanbanBoardDraft, KanbanItem } from "../../../shared/kanban"

const list = (s: string) =>
  s
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)

type TestResult =
  | { ok: true; count: number; items: KanbanItem[] }
  | { ok: false; reason: string }

// "New board" without the agent: a built-in GitHub / Azure DevOps recipe plus
// the basic intake filter. Advanced filters live in the board's settings.
export function NewBoardDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (boardId: string) => void
}) {
  const [name, setName] = useState("")
  const [tracker, setTracker] = useState<"github" | "ado">("github")
  const [repo, setRepo] = useState("")
  const [org, setOrg] = useState("")
  const [project, setProject] = useState("")
  const [workspace, setWorkspace] = useState("")
  const [tags, setTags] = useState("")
  const [match, setMatch] = useState<"any" | "all">("any")
  const [exclude, setExclude] = useState("")
  const [assignee, setAssignee] = useState<"me" | "anyone" | "user">("me")
  const [user, setUser] = useState("")
  const [types, setTypes] = useState("")
  const [states, setStates] = useState("")
  const [fieldRules, setFieldRules] = useState<
    { field: string; values: string }[]
  >([])
  const [busy, setBusy] = useState<"test" | "create" | null>(null)
  const [test, setTest] = useState<TestResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const draft = (): KanbanBoardDraft => ({
    name,
    workspace,
    target:
      tracker === "github" ? { tracker, repo } : { tracker, org, project },
    filter: {
      tags: list(tags),
      match,
      excludeTags: list(exclude),
      assignee:
        assignee === "user" ? { mode: "user", user } : { mode: assignee },
      // GitHub's preset maps no type, and its states are only open/closed.
      types: tracker === "ado" ? list(types) : [],
      states: tracker === "ado" ? list(states) : [],
      fields:
        tracker === "ado"
          ? fieldRules
              .map((r) => ({ field: r.field.trim(), values: list(r.values) }))
              .filter((r) => r.field && r.values.length)
          : undefined,
    },
  })

  async function pickFolder() {
    const picked = await window.cowork.pickWorkspace()
    if (picked.path) setWorkspace(picked.path)
  }

  async function runTest() {
    setBusy("test")
    setError(null)
    setTest(await window.cowork.kanban.testDraft(draft()))
    setBusy(null)
  }

  async function create() {
    setBusy("create")
    setError(null)
    const result = await window.cowork.kanban.create(draft())
    setBusy(null)
    if (!result.ok) return setError(result.reason)
    onCreated(result.boardId)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New board</DialogTitle>
          <DialogDescription>
            Pull issues with the GitHub CLI (gh) or Azure CLI (az boards),
            signed in on this machine. Columns and more filters are in the
            board&apos;s settings afterwards.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_10rem]">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="nb-name">Name</Label>
              <Input
                id="nb-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="nb-tracker">Tracker</Label>
              <NativeSelect
                className="w-full"
                id="nb-tracker"
                value={tracker}
                onChange={(e) => {
                  setTracker(e.target.value as "github" | "ado")
                  setTest(null)
                }}
              >
                <NativeSelectOption value="github">GitHub</NativeSelectOption>
                <NativeSelectOption value="ado">
                  Azure DevOps
                </NativeSelectOption>
              </NativeSelect>
            </div>
          </div>

          {tracker === "github" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="nb-repo">Repository</Label>
              <Input
                id="nb-repo"
                placeholder="owner/repo"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
              />
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="nb-org">Organization</Label>
                <Input
                  id="nb-org"
                  placeholder="dev.azure.com/<org>"
                  value={org}
                  onChange={(e) => setOrg(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="nb-project">Project</Label>
                <Input
                  id="nb-project"
                  value={project}
                  onChange={(e) => setProject(e.target.value)}
                />
              </div>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="nb-workspace">Workspace folder</Label>
            <div className="flex gap-2">
              <Input
                id="nb-workspace"
                readOnly
                placeholder="Where cards run"
                value={workspace}
              />
              <Button variant="outline" onClick={() => void pickFolder()}>
                <FolderOpen className="size-4" />
                Choose
              </Button>
            </div>
          </div>

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-2 text-sm font-medium">
              Intake filter (blank = any)
            </legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_10rem]">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="nb-tags">Tags (comma-separated)</Label>
                <Input
                  id="nb-tags"
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="nb-match">Match</Label>
                <NativeSelect
                  className="w-full"
                  id="nb-match"
                  value={match}
                  onChange={(e) => setMatch(e.target.value as "any" | "all")}
                >
                  <NativeSelectOption value="any">any</NativeSelectOption>
                  <NativeSelectOption value="all">all</NativeSelectOption>
                </NativeSelect>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="nb-exclude">Exclude tags</Label>
              <Input
                id="nb-exclude"
                value={exclude}
                onChange={(e) => setExclude(e.target.value)}
              />
            </div>
            {tracker === "ado" ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="nb-types">Types</Label>
                  <Input
                    id="nb-types"
                    placeholder="Any"
                    value={types}
                    onChange={(e) => setTypes(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="nb-states">States</Label>
                  <Input
                    id="nb-states"
                    placeholder="Any open state"
                    value={states}
                    onChange={(e) => setStates(e.target.value)}
                  />
                </div>
              </div>
            ) : null}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[10rem_1fr]">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="nb-assignee">Assignee</Label>
                <NativeSelect
                  className="w-full"
                  id="nb-assignee"
                  value={assignee}
                  onChange={(e) =>
                    setAssignee(e.target.value as "me" | "anyone" | "user")
                  }
                >
                  <NativeSelectOption value="me">me</NativeSelectOption>
                  <NativeSelectOption value="anyone">anyone</NativeSelectOption>
                  <NativeSelectOption value="user">a person</NativeSelectOption>
                </NativeSelect>
              </div>
              {assignee === "user" ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="nb-user">
                    {tracker === "github" ? "GitHub login" : "Email"}
                  </Label>
                  <Input
                    id="nb-user"
                    value={user}
                    onChange={(e) => setUser(e.target.value)}
                  />
                </div>
              ) : null}
            </div>
            {tracker === "ado" ? (
              <div className="flex flex-col gap-1.5">
                <Label>Custom fields</Label>
                {fieldRules.map((rule, i) => (
                  <div key={i} className="flex gap-2">
                    <Input
                      aria-label="Field reference name"
                      placeholder="Custom.QAAssigned"
                      value={rule.field}
                      onChange={(e) =>
                        setFieldRules(
                          fieldRules.map((r, j) =>
                            j === i ? { ...r, field: e.target.value } : r
                          )
                        )
                      }
                    />
                    <Input
                      aria-label="Values (comma-separated)"
                      placeholder="One of… (comma-separated)"
                      value={rule.values}
                      onChange={(e) =>
                        setFieldRules(
                          fieldRules.map((r, j) =>
                            j === i ? { ...r, values: e.target.value } : r
                          )
                        )
                      }
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Remove field"
                      onClick={() =>
                        setFieldRules(fieldRules.filter((_, j) => j !== i))
                      }
                    >
                      <XIcon />
                    </Button>
                  </div>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  className="self-start"
                  onClick={() =>
                    setFieldRules([...fieldRules, { field: "", values: "" }])
                  }
                >
                  <Plus className="size-4" />
                  Add custom field
                </Button>
                <p className="text-xs text-muted-foreground">
                  Use the field&apos;s reference name (Process settings → field
                  → Reference name). People match by name or email.
                </p>
              </div>
            ) : null}
          </fieldset>

          {test ? (
            test.ok ? (
              <div className="rounded-md border p-2 text-xs">
                <p className="font-medium">
                  {test.count} matching item{test.count === 1 ? "" : "s"}
                </p>
                <ul className="mt-1 list-disc pl-4 text-muted-foreground">
                  {test.items.map((item) => (
                    <li key={item.id} className="truncate">
                      #{item.id} {item.title}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-xs text-destructive">{test.reason}</p>
            )
          ) : null}
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            disabled={!!busy}
            onClick={() => void runTest()}
          >
            {busy === "test" ? <Spinner /> : null}
            Test
          </Button>
          <Button disabled={!!busy} onClick={() => void create()}>
            {busy === "create" ? <Spinner /> : null}
            Create board
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
