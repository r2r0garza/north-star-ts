import { randomUUID } from "crypto"
import { getDb } from "../connection"
import type {
  GeneratedFilesRule,
  Workspace,
  WorkspaceMissionControlSettings,
  WorktreeSetup,
  WorktreeSetupStep,
} from "../types"
import {
  DEFAULT_CHECKS_DIR,
  normalizeChecksDir,
} from "../../../shared/mission-control/checks"

interface WorkspaceRow {
  id: string
  path: string
  name: string | null
  generated_files: string | null
  worktree_setup: string | null
  mission_control: string | null
  created_at: number
  updated_at: number
}

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    generatedFiles: parseGeneratedFiles(row.generated_files),
    worktreeSetup: parseWorktreeSetup(row.worktree_setup),
    missionControl: parseMissionControl(row.mission_control),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function parseGeneratedFiles(value: string | null): GeneratedFilesRule[] {
  try {
    return normalizeGeneratedFiles(JSON.parse(value ?? "[]"))
  } catch {
    return []
  }
}

// Keep well-formed rules only: at least one non-empty glob and a command.
export function normalizeGeneratedFiles(value: unknown): GeneratedFilesRule[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((rule) => {
    const paths = Array.isArray(rule?.paths)
      ? rule.paths
          .filter((p: unknown): p is string => typeof p === "string")
          .map((p: string) => p.trim().replace(/^\.?\/+/, ""))
          .filter(Boolean)
      : []
    const command = typeof rule?.command === "string" ? rule.command.trim() : ""
    return paths.length && command ? [{ paths, command }] : []
  })
}

function parseWorktreeSetup(value: string | null): WorktreeSetup {
  try {
    return normalizeWorktreeSetup(JSON.parse(value ?? "{}"))
  } catch {
    return { linkPaths: [], steps: [] }
  }
}

// A workspace-relative path: no absolute or parent segments, no leading "./"
// or trailing slash. Null when it would leave the workspace.
function relativePath(value: string): string | null {
  const p = value
    .trim()
    .replace(/^\.?\/+/, "")
    .replace(/\/+$/, "")
  if (p === ".") return ""
  return p.split("/").includes("..") ? null : p
}

// Workspace-relative link paths and well-formed setup steps. The older shape
// with a single `command` becomes one user-authored step, so its behavior is
// unchanged (plan 106.11).
export function normalizeWorktreeSetup(value: unknown): WorktreeSetup {
  const v = (value ?? {}) as {
    linkPaths?: unknown
    command?: unknown
    steps?: unknown
  }
  const linkPaths = Array.isArray(v.linkPaths)
    ? [
        ...new Set(
          v.linkPaths
            .filter((p): p is string => typeof p === "string")
            .map(relativePath)
            .filter((p): p is string => !!p)
        ),
      ]
    : []
  const steps: WorktreeSetupStep[] = []
  const ids = new Set<string>()
  const raw = Array.isArray(v.steps)
    ? v.steps
    : typeof v.command === "string" && v.command.trim()
      ? [
          {
            id: "legacy-command",
            label: "Setup command",
            command: v.command,
            cwd: "",
            source: "user",
          },
        ]
      : []
  for (const item of raw as Array<Record<string, unknown>>) {
    const command = typeof item?.command === "string" ? item.command.trim() : ""
    const cwd = relativePath(typeof item?.cwd === "string" ? item.cwd : "")
    if (!command || cwd === null) continue
    let id =
      typeof item.id === "string" && item.id.trim()
        ? item.id.trim()
        : `step-${steps.length + 1}`
    while (ids.has(id)) id = `${id}-${steps.length + 1}`
    ids.add(id)
    const label =
      typeof item.label === "string" && item.label.trim()
        ? item.label.trim()
        : command
    const source = item.source === "analysis" ? "analysis" : "user"
    const commands = (value: unknown) =>
      Array.isArray(value)
        ? value
            .map((c: { label?: unknown; command?: unknown }) => ({
              label: typeof c?.label === "string" ? c.label.trim() : "",
              command: typeof c?.command === "string" ? c.command.trim() : "",
            }))
            .filter((c) => c.command)
            .map((c) => ({ label: c.label || c.command, command: c.command }))
        : []
    const shared = item.kind === "python-shared-venv"
    const venv =
      shared && typeof item.venv === "string" ? relativePath(item.venv) : null
    steps.push({
      id,
      label,
      command,
      cwd,
      source,
      ...(typeof item.findingKey === "string" && item.findingKey
        ? { findingKey: item.findingKey }
        : {}),
      ...(shared
        ? {
            kind: "python-shared-venv" as const,
            venv: venv || ".venv",
            fallback: commands(item.fallback),
            refresh: commands(item.refresh),
          }
        : {}),
    })
  }
  return { linkPaths, steps }
}

function parseMissionControl(
  value: string | null
): WorkspaceMissionControlSettings {
  try {
    return normalizeMissionControlSettings(JSON.parse(value ?? "{}"))
  } catch {
    return normalizeMissionControlSettings({})
  }
}

// Fill defaults and drop what can't be valid: a checks directory that is the
// workspace root, leaves it, or sits in .git falls back to the default.
export function normalizeMissionControlSettings(
  value: unknown
): WorkspaceMissionControlSettings {
  const v = (value ?? {}) as { checksDir?: unknown }
  return { checksDir: normalizeChecksDir(v.checksDir) ?? DEFAULT_CHECKS_DIR }
}

// Last segment of a path, e.g. "/Users/me/proj" -> "proj". Used as a default name.
function lastSegment(path: string): string {
  const parts = path.replace(/[/\\]+$/, "").split(/[/\\]/)
  return parts[parts.length - 1] || path
}

export function getWorkspace(id: string): Workspace | undefined {
  const row = getDb()
    .prepare("SELECT * FROM workspaces WHERE id = ?")
    .get(id) as WorkspaceRow | undefined
  return row ? toWorkspace(row) : undefined
}

export function getWorkspaceByPath(path: string): Workspace | undefined {
  const row = getDb()
    .prepare("SELECT * FROM workspaces WHERE path = ?")
    .get(path) as WorkspaceRow | undefined
  return row ? toWorkspace(row) : undefined
}

// Return the existing workspace for `path` (deduped on the UNIQUE path) or
// create one. Bumps `name` if a new one is supplied for an existing row.
export function upsertWorkspace(path: string, name?: string): Workspace {
  const existing = getWorkspaceByPath(path)
  const now = Date.now()
  if (existing) {
    if (name && name !== existing.name) {
      getDb()
        .prepare("UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?")
        .run(name, now, existing.id)
      return { ...existing, name, updatedAt: now }
    }
    return existing
  }
  const id = randomUUID()
  getDb()
    .prepare(
      "INSERT INTO workspaces (id, path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(id, path, name ?? lastSegment(path), now, now)
  return getWorkspace(id)!
}

// The directory a conversation or Process run works in: its own working
// directory (a Mission Control worktree) when it has one, else its
// workspace's path.
export function workingDirectoryOf(
  owner:
    | { workspaceId: string | null; workingDirectory?: string | null }
    | null
    | undefined
): string | undefined {
  if (owner?.workingDirectory) return owner.workingDirectory
  return owner?.workspaceId ? getWorkspace(owner.workspaceId)?.path : undefined
}

// Hidden workspaces (older Mission Control worktrees, plan 106.5) stay out of
// the user's workspace lists.
export function listWorkspaces(): Workspace[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM workspaces WHERE hidden = 0 ORDER BY updated_at DESC"
    )
    .all() as WorkspaceRow[]
  return rows.map(toWorkspace)
}

export function updateWorkspace(
  id: string,
  patch: {
    name?: string
    generatedFiles?: GeneratedFilesRule[]
    worktreeSetup?: WorktreeSetup
    missionControl?: Partial<WorkspaceMissionControlSettings>
  }
): Workspace {
  const now = Date.now()
  if (patch.name !== undefined) {
    getDb()
      .prepare("UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?")
      .run(patch.name, now, id)
  }
  if (patch.generatedFiles !== undefined) {
    getDb()
      .prepare(
        "UPDATE workspaces SET generated_files = ?, updated_at = ? WHERE id = ?"
      )
      .run(
        JSON.stringify(normalizeGeneratedFiles(patch.generatedFiles)),
        now,
        id
      )
  }
  if (patch.worktreeSetup !== undefined) {
    getDb()
      .prepare(
        "UPDATE workspaces SET worktree_setup = ?, updated_at = ? WHERE id = ?"
      )
      .run(JSON.stringify(normalizeWorktreeSetup(patch.worktreeSetup)), now, id)
  }
  if (patch.missionControl !== undefined) {
    const current = getWorkspace(id)?.missionControl
    if (
      patch.missionControl.checksDir !== undefined &&
      normalizeChecksDir(patch.missionControl.checksDir) === null
    )
      throw new Error(
        "The checks directory must be a folder inside the workspace (not the workspace root or .git)."
      )
    getDb()
      .prepare(
        "UPDATE workspaces SET mission_control = ?, updated_at = ? WHERE id = ?"
      )
      .run(
        JSON.stringify(
          normalizeMissionControlSettings({
            ...current,
            ...patch.missionControl,
          })
        ),
        now,
        id
      )
  }
  return getWorkspace(id)!
}

export function deleteWorkspace(id: string): void {
  getDb().prepare("DELETE FROM workspaces WHERE id = ?").run(id)
}
