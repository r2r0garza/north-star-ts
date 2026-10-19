import type Database from "better-sqlite3"
import type { WorkflowDefinition } from "../../shared/workflows"

export const EXAMPLE_WORKFLOWS: WorkflowDefinition[] = [
  {
    id: "code-review",
    name: "Code review",
    description: "Review changes, identify risks, and summarize findings.",
    defaultObjective: "",
    steps: [
      {
        id: "review-changes",
        title: "Review changes",
        instructions: "Inspect the changes and the surrounding code.",
      },
      {
        id: "identify-risks",
        title: "Identify risks",
        instructions: "Look for bugs, security concerns, and missing tests.",
      },
      {
        id: "summarize-findings",
        title: "Summarize findings",
        instructions: "Report actionable findings with supporting evidence.",
      },
    ],
  },
  {
    id: "project-health",
    name: "Project health check",
    description: "Check project quality and surface areas that need attention.",
    defaultObjective: "",
    steps: [
      {
        id: "check-quality",
        title: "Check quality",
        instructions: "Review the project structure and run available checks.",
      },
      {
        id: "report-health",
        title: "Report project health",
        instructions: "Summarize issues and suggest priorities.",
      },
    ],
  },
  {
    id: "release-preparation",
    name: "Release preparation",
    description: "Review readiness and put together a release summary.",
    defaultObjective: "",
    steps: [
      {
        id: "review-readiness",
        title: "Review readiness",
        instructions: "Check tests and outstanding release blockers.",
      },
      {
        id: "release-summary",
        title: "Prepare release summary",
        instructions: "Summarize the changes included in the release.",
      },
    ],
  },
]

export function ensureWorkflowRuns(db: Database.Database): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS workflow_runs (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)))"
  )
}

export function ensureWorkflows(db: Database.Database): void {
  const exists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workflows'"
    )
    .get()
  if (exists) return
  db.exec(`CREATE TABLE workflows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    steps TEXT NOT NULL CHECK(json_valid(steps)),
    position INTEGER NOT NULL
  )`)
  const insert = db.prepare(
    "INSERT INTO workflows (id, name, description, steps, position) VALUES (?, ?, ?, ?, ?)"
  )
  EXAMPLE_WORKFLOWS.forEach((workflow, position) => {
    insert.run(
      workflow.id,
      workflow.name,
      workflow.description,
      JSON.stringify(workflow.steps),
      position
    )
  })
}
