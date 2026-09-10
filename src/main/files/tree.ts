import { lstat, readdir, realpath } from "fs/promises"
import { isAbsolute, relative, resolve, sep } from "path"
import { resolveInWorkspace } from "../agent/tools/workspace"

const ENTRY_LIMIT = 2_000

export type WorkspaceEntryKind = "directory" | "file" | "symlink" | "other"

export type WorkspaceEntry = {
  name: string
  path: string
  kind: WorkspaceEntryKind
}

export type ListDirectoryResult = {
  entries: WorkspaceEntry[]
  error: string | null
  truncated: boolean
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  )
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/")
}

function entryKind(
  entry: Awaited<ReturnType<typeof lstat>>
): WorkspaceEntryKind {
  if (entry.isSymbolicLink()) return "symlink"
  if (entry.isDirectory()) return "directory"
  if (entry.isFile()) return "file"
  return "other"
}

function compareEntries(a: WorkspaceEntry, b: WorkspaceEntry): number {
  const aDirectory = a.kind === "directory"
  const bDirectory = b.kind === "directory"
  if (aDirectory !== bDirectory) return aDirectory ? -1 : 1
  return (
    a.name.localeCompare(b.name, undefined, { sensitivity: "accent" }) ||
    (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  )
}

export async function listWorkspaceDirectory(
  workspace: string,
  relDirectory: string
): Promise<ListDirectoryResult> {
  if (!workspace.trim()) {
    return { entries: [], error: "No workspace selected.", truncated: false }
  }

  let root: string
  let directory: string
  try {
    root = await realpath(workspace)
    directory = resolveInWorkspace(root, relDirectory || ".")
    const stat = await lstat(directory)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return {
        entries: [],
        error: "Path is not a directory.",
        truncated: false,
      }
    }
    const realDirectory = await realpath(directory)
    if (!isInside(root, realDirectory)) {
      return {
        entries: [],
        error: "Path is outside the workspace.",
        truncated: false,
      }
    }
  } catch {
    return { entries: [], error: "Directory is unavailable.", truncated: false }
  }

  let names: string[]
  try {
    names = await readdir(directory)
  } catch {
    return { entries: [], error: "Directory is unavailable.", truncated: false }
  }

  const truncated = names.length > ENTRY_LIMIT
  const entries: WorkspaceEntry[] = []
  for (const name of names.slice(0, ENTRY_LIMIT)) {
    const path = resolve(directory, name)
    try {
      const stat = await lstat(path)
      entries.push({
        name,
        path: toPosix(relative(root, path)),
        kind: entryKind(stat),
      })
    } catch {
      // An entry can disappear between readdir and lstat; omit it rather than
      // failing the whole directory response.
    }
  }

  entries.sort(compareEntries)
  return {
    entries,
    error: truncated ? "Directory is too large to show completely." : null,
    truncated,
  }
}
