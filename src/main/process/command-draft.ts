import { readdir, readFile, stat } from "fs/promises"
import { join } from "path"
import {
  resolveLlm,
  createCompletion,
  type LlmSelection,
} from "../agent/providers"
import * as processes from "../db/repositories/processes"
import { getWorkspace, getWorkspaceByPath } from "../db/repositories/workspaces"
import {
  parseCheckName,
  parseWorkspaceCheck,
} from "../../shared/process-command"
import {
  environmentFacts,
  type EnvironmentFact,
} from "../mission-control/workspace-analysis/analyze"

// Ask AI for a command (plan 104). An AUTHORING aid only: one bounded model
// call proposes a command from the step or check name, the Process's own text,
// and a little workspace metadata. The proposal is returned inert — the UI
// shows it for review and the user saves it (or not). Nothing here runs it.

const MAX_DRAFT_TOKENS = 400
const MAX_ROOT_ENTRIES = 80
const MAX_PACKAGE_JSON_BYTES = 64 * 1024
const MAX_SCRIPTS = 40

export interface CommandDraft {
  command: string
  cwd: string | null
  rationale: string
}

export const SYSTEM_PROMPT =
  "You propose ONE shell command for a deterministic step in an automated workflow. " +
  "The command runs non-interactively in the workspace root; its exit status decides " +
  "whether the step passed. It runs in a plain shell: no virtual environment is " +
  "activated and no shell profile is loaded. So when the facts list a project " +
  "environment with an interpreter (for example `.venv/bin/python`), call the tool " +
  "through that interpreter (`.venv/bin/python -m pytest`), never a bare `python`, " +
  "`python3`, or `pytest`. When the facts list a runner instead (`uv run`, `poetry run`, " +
  "`pipenv run`), run the tool through it (`poetry run pytest`): the manager may keep its " +
  "environment outside the project. If the environment is missing, still use the path " +
  "or runner its setup provides; setting it up is a separate step the user takes. " +
  "Prefer the project's own " +
  "scripts (for example `pnpm test` when package.json has a test script and a pnpm " +
  "lockfile). Never install dependencies, never prompt for input, never start a " +
  "long-running server, and never chain unrelated work. " +
  'Answer with JSON only: {"command": string, "cwd": string | null, "rationale": string}. ' +
  "`cwd` is a workspace-relative folder or null for the root; `rationale` is one short sentence."

// What to draft: a literal command for a phase (from the builder, which has no
// workspace: the process's last run supplies one if any), or the command a
// named check runs in a given workspace (from run start, where the workspace
// is known).
export type CommandDraftRequest = {
  instruction?: string | null
  selection?: LlmSelection
} & (
  | { phaseId: string }
  | { check: string; processId?: string | null; workspacePath: string }
)

export async function draftCommand(
  input: CommandDraftRequest
): Promise<CommandDraft> {
  const lines: string[] = []
  let workspacePath: string | null
  if ("phaseId" in input) {
    const phase = processes.getPhase(input.phaseId)
    if (!phase) throw new Error("Phase not found")
    const definition = processes.getProcessDefinition(phase.processId)
    workspacePath = latestRunWorkspace(phase.processId)
    lines.push(
      `Process: ${definition?.name ?? "(unnamed)"}`,
      definition?.description ? `Description: ${definition.description}` : "",
      `Step: ${phase.name}`,
      phase.commandConfig?.source === "literal"
        ? `Current command: ${phase.commandConfig.command}`
        : ""
    )
  } else {
    const check = parseCheckName(input.check)
    workspacePath = input.workspacePath
    const definition = input.processId
      ? processes.getProcessDefinition(input.processId)
      : undefined
    const steps = input.processId
      ? processes
          .listPhases(input.processId)
          .filter(
            (p) =>
              p.commandConfig?.source === "check" &&
              p.commandConfig.check === check
          )
          .map((p) => p.name)
      : []
    const current = getWorkspaceByPath(workspacePath)?.commandChecks[check]
    lines.push(
      `Workspace check to define: "${check}" — what this project runs for it.`,
      definition ? `Used by the process: ${definition.name}` : "",
      steps.length ? `Steps that run it: ${steps.join(", ")}` : "",
      current ? `Current command: ${current.command}` : ""
    )
  }
  const metadata = workspacePath
    ? await workspaceMetadata(workspacePath)
    : "No workspace is known for this process yet."
  const user = [
    ...lines,
    input.instruction?.trim() ? `Request: ${input.instruction.trim()}` : "",
    `Workspace:\n${metadata}`,
  ]
    .filter(Boolean)
    .join("\n\n")

  const { client, model, apiMode } = resolveLlm(
    input.selection ?? { accountId: null, modelId: null }
  )
  const res = await createCompletion(
    client,
    model,
    MAX_DRAFT_TOKENS,
    {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: user },
      ],
    },
    [],
    apiMode
  )
  const content = (res as { choices?: { message?: { content?: unknown } }[] })
    .choices?.[0]?.message?.content
  return parseDraft(contentToText(content))
}

export function parseDraft(text: string): CommandDraft {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) throw new Error("The model did not propose a command.")
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(match[0]) as Record<string, unknown>
  } catch {
    throw new Error("The model's proposal was not valid JSON.")
  }
  const check = parseWorkspaceCheck({
    command: raw.command,
    cwd: typeof raw.cwd === "string" ? raw.cwd : null,
  })
  return {
    ...check,
    rationale:
      typeof raw.rationale === "string"
        ? raw.rationale.trim().slice(0, 500)
        : "",
  }
}

// The workspace of the process's most recent run: a definition has no
// workspace of its own, but its last run shows where it is used.
function latestRunWorkspace(processId: string): string | null {
  for (const run of processes.listProcessRuns({ processId })) {
    if (run.workingDirectory) return run.workingDirectory
    if (run.workspaceId) {
      const workspace = getWorkspace(run.workspaceId)
      if (workspace) return workspace.path
    }
  }
  return null
}

// Bounded, read-only facts about the workspace root: its top-level entries and
// package.json scripts. Never file contents beyond that.
async function workspaceMetadata(root: string): Promise<string> {
  const lines: string[] = []
  try {
    // Hidden entries matter here: .venv, .python-version, .nvmrc, …
    const entries = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.name !== ".git" && e.name !== ".DS_Store")
      .slice(0, MAX_ROOT_ENTRIES)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    lines.push(`Top-level entries: ${entries.join(", ") || "(none)"}`)
  } catch {
    return "The workspace folder could not be read."
  }
  try {
    const facts = await environmentFacts(root)
    if (facts.length)
      lines.push(`Project environments:\n${describeFacts(facts)}`)
  } catch {
    // Detection is a help, not a requirement.
  }
  try {
    const path = join(root, "package.json")
    if ((await stat(path)).size <= MAX_PACKAGE_JSON_BYTES) {
      const pkg = JSON.parse(await readFile(path, "utf8")) as {
        scripts?: Record<string, unknown>
        packageManager?: unknown
      }
      const scripts = Object.entries(pkg.scripts ?? {})
        .filter(([, v]) => typeof v === "string")
        .slice(0, MAX_SCRIPTS)
        .map(([k, v]) => `  ${k}: ${String(v).slice(0, 200)}`)
      if (typeof pkg.packageManager === "string")
        lines.push(`packageManager: ${pkg.packageManager}`)
      if (scripts.length)
        lines.push(`package.json scripts:\n${scripts.join("\n")}`)
    }
  } catch {
    // No package.json, or unreadable: the entries above still help.
  }
  return lines.join("\n")
}

// The environment facts as plain lines for the prompt.
export function describeFacts(facts: EnvironmentFact[]): string {
  return facts
    .map((fact) => {
      const where = fact.root ? ` in ${fact.root}/` : ""
      const parts = [`- ${fact.noun} (${fact.manager})${where}: ${fact.status}`]
      if (fact.interpreter) parts.push(`interpreter ${fact.interpreter}`)
      if (fact.runner) parts.push(`runner \`${fact.runner}\``)
      if (fact.tools.length) parts.push(`installed: ${fact.tools.join(", ")}`)
      if (fact.status === "missing" || fact.status === "stale")
        parts.push(
          `setup (the user runs it separately): ${fact.setup.map((c) => c.command).join(" ; ")}`
        )
      return parts.join("; ")
    })
    .join("\n")
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content))
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : ((part as { text?: string })?.text ?? "")
      )
      .join("")
  return ""
}
