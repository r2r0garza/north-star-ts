import { randomUUID } from "crypto"
import { getDb } from "../connection"
import type {
  Playbook,
  PlaybookAltitude,
  PlaybookHook,
  PlaybookHookName,
  PlaybookRun,
  PlaybookRunStatus,
  PlaybookWithHooks,
  SliceProof,
} from "../types"
import {
  createProcessDefinition,
  deleteProcessDefinition,
  getProcessDefinition,
} from "./processes"

// Mission Control playbooks (plan 106.3). A playbook is a thin altitude wrapper
// around Process definitions: each hook names the definition it runs, and the
// existing Process builder edits the steps. Enum-like columns are bare TEXT and
// validated here, matching the Process and rig repositories.

export const PLAYBOOK_ALTITUDES: readonly PlaybookAltitude[] = [
  "slice",
  "mission",
  "initiative",
]

export const PLAYBOOK_HOOKS: Record<
  PlaybookAltitude,
  readonly PlaybookHookName[]
> = {
  slice: ["run"],
  mission: ["before_slices", "after_each_slice", "after_all_slices"],
  initiative: ["plan", "between_missions", "on_complete"],
}

interface PlaybookRow {
  id: string
  name: string
  altitude: PlaybookAltitude
  description: string | null
  created_at: number
  updated_at: number
}
interface PlaybookHookRow {
  id: string
  playbook_id: string
  hook: PlaybookHookName
  process_id: string
}
interface PlaybookRunRow {
  id: string
  playbook_id: string | null
  hook: PlaybookHookName
  initiative_id: string
  mission_id: string | null
  slice_id: string | null
  process_run_id: string | null
  status: PlaybookRunStatus
  proof: string | null
  proof_revisions: number
  outcome_reason: string | null
  worktree_path: string | null
  created_at: number
  finished_at: number | null
}

function toPlaybook(row: PlaybookRow): Playbook {
  return {
    id: row.id,
    name: row.name,
    altitude: row.altitude,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
function toHook(row: PlaybookHookRow): PlaybookHook {
  return {
    id: row.id,
    playbookId: row.playbook_id,
    hook: row.hook,
    processId: row.process_id,
  }
}
function toRun(row: PlaybookRunRow): PlaybookRun {
  let proof: SliceProof | null = null
  if (row.proof !== null) {
    try {
      proof = JSON.parse(row.proof) as SliceProof
    } catch {
      proof = null
    }
  }
  return {
    id: row.id,
    playbookId: row.playbook_id,
    hook: row.hook,
    initiativeId: row.initiative_id,
    missionId: row.mission_id,
    sliceId: row.slice_id,
    processRunId: row.process_run_id,
    status: row.status,
    proof,
    proofRevisions: row.proof_revisions,
    outcomeReason: row.outcome_reason,
    worktreePath: row.worktree_path,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  }
}

function altitude(value: string): PlaybookAltitude {
  if (!PLAYBOOK_ALTITUDES.includes(value as PlaybookAltitude))
    throw new Error(`Unknown playbook altitude: ${value}`)
  return value as PlaybookAltitude
}

export function assertHookForAltitude(
  playbookAltitude: PlaybookAltitude,
  hook: string
): PlaybookHookName {
  if (!PLAYBOOK_HOOKS[playbookAltitude].includes(hook as PlaybookHookName))
    throw new Error(
      `A ${playbookAltitude} playbook has no '${hook}' hook. Expected one of: ${PLAYBOOK_HOOKS[playbookAltitude].join(", ")}.`
    )
  return hook as PlaybookHookName
}

// ── playbooks ────────────────────────────────────────────────────────────────

export function getPlaybook(id: string): PlaybookWithHooks | null {
  const row = getDb().prepare("SELECT * FROM playbooks WHERE id = ?").get(id) as
    | PlaybookRow
    | undefined
  return row ? { ...toPlaybook(row), hooks: listHooks(row.id) } : null
}

export function listPlaybooks(): PlaybookWithHooks[] {
  return (
    getDb()
      .prepare("SELECT * FROM playbooks ORDER BY altitude, name COLLATE NOCASE")
      .all() as PlaybookRow[]
  ).map((row) => ({ ...toPlaybook(row), hooks: listHooks(row.id) }))
}

export function createPlaybook(input: {
  name: string
  altitude: PlaybookAltitude
  description?: string | null
}): PlaybookWithHooks {
  const name = input.name.trim()
  if (!name) throw new Error("Playbook name is required.")
  const id = randomUUID()
  const now = Date.now()
  getDb()
    .prepare(
      "INSERT INTO playbooks (id, name, altitude, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(
      id,
      name,
      altitude(input.altitude),
      input.description ?? null,
      now,
      now
    )
  return getPlaybook(id)!
}

export function updatePlaybook(
  id: string,
  patch: { name?: string; description?: string | null }
): PlaybookWithHooks {
  const sets: string[] = []
  const values: unknown[] = []
  if (patch.name !== undefined) {
    const name = patch.name.trim()
    if (!name) throw new Error("Playbook name is required.")
    sets.push("name = ?")
    values.push(name)
  }
  if (patch.description !== undefined) {
    sets.push("description = ?")
    values.push(patch.description)
  }
  if (sets.length) {
    sets.push("updated_at = ?")
    values.push(Date.now(), id)
    getDb()
      .prepare(`UPDATE playbooks SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values)
  }
  const playbook = getPlaybook(id)
  if (!playbook) throw new Error(`Playbook not found: ${id}`)
  return playbook
}

// Deleting a playbook also deletes the hook definitions it owns, unless another
// playbook still references one. Past Process runs keep their rows (their
// process_id is SET NULL), and playbook_runs keep their history.
export function deletePlaybook(id: string): void {
  const playbook = getPlaybook(id)
  if (!playbook) return
  getDb().transaction(() => {
    getDb().prepare("DELETE FROM playbooks WHERE id = ?").run(id)
    // playbook_id on work rows has no FK; clear it so they show the default.
    for (const table of ["initiatives", "missions", "slices"])
      getDb()
        .prepare(`UPDATE ${table} SET playbook_id = NULL WHERE playbook_id = ?`)
        .run(id)
    for (const hook of playbook.hooks) {
      const stillUsed = getDb()
        .prepare("SELECT 1 FROM playbook_hooks WHERE process_id = ? LIMIT 1")
        .get(hook.processId)
      if (stillUsed) continue
      try {
        deleteProcessDefinition(hook.processId)
      } catch {
        // Phase-runs still reference its phases (run history): keep the
        // definition as an ordinary Process rather than losing that history.
      }
    }
  })()
}

// ── hooks ────────────────────────────────────────────────────────────────────

export function listHooks(playbookId: string): PlaybookHook[] {
  return (
    getDb()
      .prepare("SELECT * FROM playbook_hooks WHERE playbook_id = ? ORDER BY hook")
      .all(playbookId) as PlaybookHookRow[]
  ).map(toHook)
}

export function getHook(
  playbookId: string,
  hook: PlaybookHookName
): PlaybookHook | null {
  const row = getDb()
    .prepare("SELECT * FROM playbook_hooks WHERE playbook_id = ? AND hook = ?")
    .get(playbookId, hook) as PlaybookHookRow | undefined
  return row ? toHook(row) : null
}

// Point a hook at an existing Process definition (replacing any previous one).
export function setHook(
  playbookId: string,
  hook: string,
  processId: string
): PlaybookWithHooks {
  const playbook = getPlaybook(playbookId)
  if (!playbook) throw new Error(`Playbook not found: ${playbookId}`)
  const name = assertHookForAltitude(playbook.altitude, hook)
  if (!getProcessDefinition(processId))
    throw new Error(`Process definition not found: ${processId}`)
  getDb().transaction(() => {
    getDb()
      .prepare("DELETE FROM playbook_hooks WHERE playbook_id = ? AND hook = ?")
      .run(playbookId, name)
    getDb()
      .prepare(
        "INSERT INTO playbook_hooks (id, playbook_id, hook, process_id) VALUES (?, ?, ?, ?)"
      )
      .run(randomUUID(), playbookId, name, processId)
    getDb()
      .prepare("UPDATE playbooks SET updated_at = ? WHERE id = ?")
      .run(Date.now(), playbookId)
  })()
  return getPlaybook(playbookId)!
}

// Create an empty Process definition for a hook and attach it. The builder then
// edits its steps in place.
export function createHookProcess(
  playbookId: string,
  hook: string
): PlaybookWithHooks {
  const playbook = getPlaybook(playbookId)
  if (!playbook) throw new Error(`Playbook not found: ${playbookId}`)
  const name = assertHookForAltitude(playbook.altitude, hook)
  if (getHook(playbookId, name))
    throw new Error(`The '${name}' hook already has a process.`)
  const definition = createProcessDefinition({
    name: `${playbook.name} · ${name.replace(/_/g, " ")}`,
    description: `Playbook step group for the ${name} hook.`,
  })
  return setHook(playbookId, name, definition.id)
}

export function removeHook(
  playbookId: string,
  hook: PlaybookHookName
): PlaybookWithHooks {
  getDb()
    .prepare("DELETE FROM playbook_hooks WHERE playbook_id = ? AND hook = ?")
    .run(playbookId, hook)
  const playbook = getPlaybook(playbookId)
  if (!playbook) throw new Error(`Playbook not found: ${playbookId}`)
  return playbook
}

// Every Process definition some playbook uses, so the legacy Processes list can
// hide playbook steps behind a filter chip.
export function listPlaybookProcessIds(): string[] {
  return (
    getDb()
      .prepare("SELECT DISTINCT process_id FROM playbook_hooks")
      .all() as Array<{ process_id: string }>
  ).map((row) => row.process_id)
}

// ── playbook runs ────────────────────────────────────────────────────────────

export function createPlaybookRun(input: {
  playbookId: string | null
  hook: PlaybookHookName
  initiativeId: string
  missionId?: string | null
  sliceId?: string | null
  worktreePath?: string | null
}): PlaybookRun {
  const id = randomUUID()
  getDb()
    .prepare(
      "INSERT INTO playbook_runs (id, playbook_id, hook, initiative_id, mission_id, slice_id, worktree_path, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)"
    )
    .run(
      id,
      input.playbookId,
      input.hook,
      input.initiativeId,
      input.missionId ?? null,
      input.sliceId ?? null,
      input.worktreePath ?? null,
      Date.now()
    )
  return getPlaybookRun(id)!
}

export function getPlaybookRun(id: string): PlaybookRun | null {
  const row = getDb()
    .prepare("SELECT * FROM playbook_runs WHERE id = ?")
    .get(id) as PlaybookRunRow | undefined
  return row ? toRun(row) : null
}

export function getPlaybookRunByProcessRunId(
  processRunId: string
): PlaybookRun | null {
  const row = getDb()
    .prepare("SELECT * FROM playbook_runs WHERE process_run_id = ?")
    .get(processRunId) as PlaybookRunRow | undefined
  return row ? toRun(row) : null
}

export function listPlaybookRuns(filter: {
  initiativeId?: string
  missionId?: string
  sliceId?: string
  status?: PlaybookRunStatus
}): PlaybookRun[] {
  const clauses: string[] = []
  const values: unknown[] = []
  if (filter.initiativeId) {
    clauses.push("initiative_id = ?")
    values.push(filter.initiativeId)
  }
  if (filter.missionId) {
    clauses.push("mission_id = ?")
    values.push(filter.missionId)
  }
  if (filter.sliceId) {
    clauses.push("slice_id = ?")
    values.push(filter.sliceId)
  }
  if (filter.status) {
    clauses.push("status = ?")
    values.push(filter.status)
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
  return (
    getDb()
      .prepare(
        `SELECT * FROM playbook_runs ${where} ORDER BY created_at DESC, id DESC`
      )
      .all(...values) as PlaybookRunRow[]
  ).map(toRun)
}

export function updatePlaybookRun(
  id: string,
  patch: {
    processRunId?: string | null
    proof?: SliceProof | null
    proofRevisions?: number
  }
): PlaybookRun {
  const sets: string[] = []
  const values: unknown[] = []
  if (patch.processRunId !== undefined) {
    sets.push("process_run_id = ?")
    values.push(patch.processRunId)
  }
  if (patch.proof !== undefined) {
    sets.push("proof = ?")
    values.push(patch.proof === null ? null : JSON.stringify(patch.proof))
  }
  if (patch.proofRevisions !== undefined) {
    sets.push("proof_revisions = ?")
    values.push(patch.proofRevisions)
  }
  if (sets.length) {
    values.push(id)
    getDb()
      .prepare(`UPDATE playbook_runs SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values)
  }
  const run = getPlaybookRun(id)
  if (!run) throw new Error(`Playbook run not found: ${id}`)
  return run
}

// Settle a playbook run exactly once. Returns false when it was already terminal
// — the idempotency guard that makes outcome application replay-safe.
export function finishPlaybookRun(
  id: string,
  status: Exclude<PlaybookRunStatus, "running">,
  outcomeReason: string | null
): boolean {
  const result = getDb()
    .prepare(
      "UPDATE playbook_runs SET status = ?, outcome_reason = ?, finished_at = ? WHERE id = ? AND status = 'running'"
    )
    .run(status, outcomeReason, Date.now(), id)
  return result.changes === 1
}
