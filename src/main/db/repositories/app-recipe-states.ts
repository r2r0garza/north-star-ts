import { getDb } from "../connection"
import type {
  AppRecipeFailureRecord,
  AppRecipeQuestion,
  AppRecipeState,
  AppRecipeStateName,
} from "../../../shared/mission-control/app-recipe"

// Recipe state per workspace and branch (plan 112.3). Rules:
// - any recipe write sets `unverified` on every branch row of the workspace;
// - `verified` holds for its commit (another commit re-verifies);
// - repair attempts and the pending question live on the row, never on a
//   story's budget.

interface Row {
  workspace_id: string
  branch: string
  state: string
  commit_oid: string | null
  failure: string | null
  repair_attempts: number
  question: string | null
  updated_at: number
}

const STATES: AppRecipeStateName[] = [
  "absent",
  "unverified",
  "verified",
  "broken",
]

function parse<T>(value: string | null): T | null {
  if (!value) return null
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

function toState(row: Row): AppRecipeState {
  return {
    workspaceId: row.workspace_id,
    branch: row.branch,
    state: STATES.includes(row.state as AppRecipeStateName)
      ? (row.state as AppRecipeStateName)
      : "unverified",
    commit: row.commit_oid,
    failure: parse<AppRecipeFailureRecord>(row.failure),
    repairAttempts: row.repair_attempts,
    question: parse<AppRecipeQuestion>(row.question),
    updatedAt: row.updated_at,
  }
}

export function getRecipeState(
  workspaceId: string,
  branch: string
): AppRecipeState | null {
  const row = getDb()
    .prepare(
      "SELECT * FROM app_recipe_states WHERE workspace_id = ? AND branch = ?"
    )
    .get(workspaceId, branch) as Row | undefined
  return row ? toState(row) : null
}

export function listRecipeStates(workspaceId: string): AppRecipeState[] {
  return (
    getDb()
      .prepare(
        "SELECT * FROM app_recipe_states WHERE workspace_id = ? ORDER BY updated_at DESC"
      )
      .all(workspaceId) as Row[]
  ).map(toState)
}

// Every pending question of the workspaces a feature uses, for its position.
export function listRecipeQuestions(featureId: string): AppRecipeQuestion[] {
  return (
    getDb()
      .prepare(
        "SELECT * FROM app_recipe_states WHERE question IS NOT NULL ORDER BY updated_at"
      )
      .all() as Row[]
  )
    .map((row) => parse<AppRecipeQuestion>(row.question))
    .filter((q): q is AppRecipeQuestion => !!q && q.featureId === featureId)
}

export function findRecipeQuestion(
  questionId: string
): { state: AppRecipeState; question: AppRecipeQuestion } | null {
  for (const row of getDb()
    .prepare("SELECT * FROM app_recipe_states WHERE question IS NOT NULL")
    .all() as Row[]) {
    const state = toState(row)
    if (state.question?.id === questionId)
      return { state, question: state.question }
  }
  return null
}

// Every save is a change now: callers spread the row they read, so its old
// updated_at is never kept.
export function saveRecipeState(
  state: Omit<AppRecipeState, "updatedAt"> & { updatedAt?: number }
): AppRecipeState {
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO app_recipe_states
         (workspace_id, branch, state, commit_oid, failure, repair_attempts, question, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, branch) DO UPDATE SET
         state = excluded.state,
         commit_oid = excluded.commit_oid,
         failure = excluded.failure,
         repair_attempts = excluded.repair_attempts,
         question = excluded.question,
         updated_at = excluded.updated_at`
    )
    .run(
      state.workspaceId,
      state.branch,
      state.state,
      state.state === "verified" ? state.commit : null,
      state.failure ? JSON.stringify(state.failure) : null,
      state.repairAttempts,
      state.question ? JSON.stringify(state.question) : null,
      now
    )
  return getRecipeState(state.workspaceId, state.branch)!
}

// A recipe write: nothing about the old recipe holds for the new one.
export function markRecipeWritten(
  workspaceId: string,
  hasRecipe: boolean
): void {
  getDb()
    .prepare(
      `UPDATE app_recipe_states
         SET state = ?, commit_oid = NULL, failure = NULL, updated_at = ?
       WHERE workspace_id = ?`
    )
    .run(hasRecipe ? "unverified" : "absent", Date.now(), workspaceId)
}
