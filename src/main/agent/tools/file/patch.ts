import { dirname } from "path"
import type { Environment } from "../../env/types"
import {
  buildDiffPreview,
  fileRevision,
  makeTempPath,
  readRevision,
  revisionOfText,
  validRevision,
  type FileDiffPreview,
} from "./mutation"

export const PATCH_LIMITS = {
  maxOperations: 24,
  maxFiles: 24,
  maxHunks: 96,
  maxInputBytes: 256 * 1024,
  maxResultBytes: 1024 * 1024,
} as const

export type PatchOperation =
  | {
      type: "add"
      path: string
      content: string
    }
  | {
      type: "update"
      path: string
      hunks: PatchHunk[]
      expected_revision?: string
    }
  | {
      type: "move"
      path: string
      new_path: string
      hunks?: PatchHunk[]
      expected_revision?: string
    }
  | {
      type: "delete"
      path: string
      expected_revision?: string
    }

export interface PatchHunk {
  old_string: string
  new_string: string
}

export interface PlannedPatchFile {
  path: string
  target: string
  before?: string
  after?: string
  beforeRevision?: string
  afterRevision?: string
  status: "added" | "updated" | "moved" | "deleted"
  sourcePath?: string
  sourceTarget?: string
}

export interface PlannedPatch {
  files: PlannedPatchFile[]
  diffs: FileDiffPreview[]
  destructive: boolean
}

interface SourceFile {
  path: string
  target: string
  content: string
  revision: string
}

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8")
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isBinary(bytes: Buffer): boolean {
  return bytes.includes(0)
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0
  let count = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    count++
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return count
}

function normalizeOperation(value: unknown): PatchOperation | string {
  if (!isPlainObject(value)) return "each operation must be an object"
  const type = value.type
  if (
    type !== "add" &&
    type !== "update" &&
    type !== "move" &&
    type !== "delete"
  ) {
    return '`type` must be "add", "update", "move", or "delete"'
  }
  const path = typeof value.path === "string" ? value.path : ""
  if (!path) return "each operation requires a string `path`"
  if (type === "add") {
    if (typeof value.content !== "string") {
      return "add operations require string `content`"
    }
    return { type, path, content: value.content }
  }
  const expected = value.expected_revision
  if (expected !== undefined && !validRevision(expected)) {
    return "`expected_revision` must be a 64-character SHA-256 hex digest"
  }
  if (type === "delete") {
    return {
      type,
      path,
      ...(expected === undefined
        ? {}
        : { expected_revision: String(expected) }),
    }
  }
  const rawHunks = value.hunks
  if (
    type === "update" &&
    (!Array.isArray(rawHunks) || rawHunks.length === 0)
  ) {
    return "update operations require a non-empty hunks array"
  }
  if (type === "move" && rawHunks !== undefined && !Array.isArray(rawHunks)) {
    return "move operation `hunks` must be an array when provided"
  }
  const hunks: PatchHunk[] = []
  for (const raw of Array.isArray(rawHunks) ? rawHunks : []) {
    if (!isPlainObject(raw)) return "each hunk must be an object"
    if (
      typeof raw.old_string !== "string" ||
      typeof raw.new_string !== "string"
    ) {
      return "each hunk requires string `old_string` and `new_string`"
    }
    if (raw.old_string === "") return "`old_string` must not be empty"
    if (raw.old_string === raw.new_string) {
      return "`old_string` and `new_string` must differ"
    }
    hunks.push({ old_string: raw.old_string, new_string: raw.new_string })
  }
  if (type === "update") {
    return {
      type,
      path,
      hunks,
      ...(expected === undefined
        ? {}
        : { expected_revision: String(expected) }),
    }
  }
  const newPath = typeof value.new_path === "string" ? value.new_path : ""
  if (!newPath) return "move operations require a string `new_path`"
  return {
    type,
    path,
    new_path: newPath,
    hunks,
    ...(expected === undefined ? {} : { expected_revision: String(expected) }),
  }
}

export function parsePatchOperations(
  value: unknown
): PatchOperation[] | string {
  if (!Array.isArray(value)) return "`operations` must be an array"
  if (value.length === 0) return "`operations` must not be empty"
  if (value.length > PATCH_LIMITS.maxOperations) {
    return `too many operations: ${value.length} > ${PATCH_LIMITS.maxOperations}`
  }
  const ops: PatchOperation[] = []
  let inputBytes = 0
  let hunks = 0
  for (const raw of value) {
    inputBytes += bytes(JSON.stringify(raw))
    const op = normalizeOperation(raw)
    if (typeof op === "string") return op
    if (op.type === "add") inputBytes += bytes(op.content)
    if (op.type === "update" || op.type === "move") {
      const opHunks = op.hunks ?? []
      hunks += opHunks.length
      for (const hunk of opHunks) {
        inputBytes += bytes(hunk.old_string) + bytes(hunk.new_string)
      }
    }
    ops.push(op)
  }
  if (hunks > PATCH_LIMITS.maxHunks) {
    return `too many hunks: ${hunks} > ${PATCH_LIMITS.maxHunks}`
  }
  if (inputBytes > PATCH_LIMITS.maxInputBytes) {
    return `patch input is too large: ${inputBytes} > ${PATCH_LIMITS.maxInputBytes} bytes`
  }
  return ops
}

function applyHunks(path: string, content: string, hunks: PatchHunk[]): string {
  let updated = content
  for (const hunk of hunks) {
    const occurrences = countOccurrences(updated, hunk.old_string)
    if (occurrences === 0) {
      throw new Error(`no_match:${path}: hunk old_string was not found`)
    }
    if (occurrences > 1) {
      throw new Error(
        `ambiguous:${path}: hunk old_string matches ${occurrences} places`
      )
    }
    updated = updated.replace(hunk.old_string, hunk.new_string)
  }
  return updated
}

async function readSource(
  env: Environment,
  path: string,
  expectedRevision?: string
): Promise<SourceFile> {
  const target = await env.resolve(path)
  let stat
  try {
    stat = await env.stat(target)
  } catch {
    throw new Error(`not_found:${path}`)
  }
  if (!stat.isFile()) throw new Error(`not_a_file:${path}`)
  const file = await env.readFile(target)
  if (isBinary(file)) throw new Error(`binary_file:${path}`)
  const revision = fileRevision(file)
  const expected = validRevision(expectedRevision)
  if (expected && expected !== revision) {
    throw new Error(`stale_file:${path}: current revision ${revision}`)
  }
  return { path, target, content: file.toString("utf8"), revision }
}

async function targetExists(
  env: Environment,
  target: string
): Promise<boolean> {
  try {
    await env.stat(target)
    return true
  } catch {
    return false
  }
}

function ensureNoCaseCollision(paths: string[]): void {
  const seen = new Map<string, string>()
  for (const path of paths) {
    const key = path.toLocaleLowerCase()
    const existing = seen.get(key)
    if (existing && existing !== path) {
      throw new Error(`case_collision:${existing} conflicts with ${path}`)
    }
    seen.set(key, path)
  }
}

export async function planPatch(
  env: Environment,
  operations: PatchOperation[]
): Promise<PlannedPatch> {
  const sourceByPath = new Map<string, SourceFile>()
  const finalByPath = new Map<string, PlannedPatchFile>()
  const finalPaths = new Set<string>()
  const deletedSources = new Set<string>()

  async function sourceFor(path: string, expectedRevision?: string) {
    const cached = sourceByPath.get(path)
    if (cached) {
      const expected = validRevision(expectedRevision)
      if (expected && expected !== cached.revision) {
        throw new Error(
          `stale_file:${path}: current revision ${cached.revision}`
        )
      }
      return cached
    }
    const source = await readSource(env, path, expectedRevision)
    sourceByPath.set(path, source)
    return source
  }

  for (const op of operations) {
    if (op.type === "add") {
      const target = await env.resolve(op.path)
      if (await targetExists(env, target))
        throw new Error(`already_exists:${op.path}`)
      if (finalByPath.has(op.path)) throw new Error(`conflict:${op.path}`)
      finalByPath.set(op.path, {
        path: op.path,
        target,
        after: op.content,
        afterRevision: revisionOfText(op.content),
        status: "added",
      })
      finalPaths.add(op.path)
      continue
    }

    const source = await sourceFor(op.path, op.expected_revision)
    if (op.type === "delete") {
      if (deletedSources.has(op.path)) throw new Error(`conflict:${op.path}`)
      deletedSources.add(op.path)
      finalByPath.set(op.path, {
        path: op.path,
        target: source.target,
        before: source.content,
        beforeRevision: source.revision,
        status: "deleted",
      })
      finalPaths.delete(op.path)
      continue
    }

    if (op.type === "update") {
      if (deletedSources.has(op.path)) throw new Error(`conflict:${op.path}`)
      const before = finalByPath.get(op.path)?.after ?? source.content
      const after = applyHunks(op.path, before, op.hunks)
      finalByPath.set(op.path, {
        path: op.path,
        target: source.target,
        before: source.content,
        after,
        beforeRevision: source.revision,
        afterRevision: revisionOfText(after),
        status: "updated",
      })
      finalPaths.add(op.path)
      continue
    }

    if (deletedSources.has(op.path)) throw new Error(`conflict:${op.path}`)
    if (finalByPath.has(op.new_path)) throw new Error(`conflict:${op.new_path}`)
    const target = await env.resolve(op.new_path)
    if (await targetExists(env, target))
      throw new Error(`already_exists:${op.new_path}`)
    const after = applyHunks(op.path, source.content, op.hunks ?? [])
    deletedSources.add(op.path)
    finalByPath.set(op.path, {
      path: op.path,
      target: source.target,
      before: source.content,
      beforeRevision: source.revision,
      status: "deleted",
    })
    finalByPath.set(op.new_path, {
      path: op.new_path,
      target,
      before: source.content,
      after,
      beforeRevision: source.revision,
      afterRevision: revisionOfText(after),
      status: "moved",
      sourcePath: op.path,
      sourceTarget: source.target,
    })
    finalPaths.delete(op.path)
    finalPaths.add(op.new_path)
  }

  if (sourceByPath.size + finalPaths.size > PATCH_LIMITS.maxFiles) {
    throw new Error(`too_many_files:${sourceByPath.size + finalPaths.size}`)
  }
  ensureNoCaseCollision([...sourceByPath.keys(), ...finalPaths])

  const files = [...finalByPath.values()].sort((a, b) =>
    a.path.localeCompare(b.path)
  )
  const resultBytes = files.reduce(
    (sum, file) => sum + bytes(file.after ?? ""),
    0
  )
  if (resultBytes > PATCH_LIMITS.maxResultBytes) {
    throw new Error(
      `result_too_large:${resultBytes} > ${PATCH_LIMITS.maxResultBytes} bytes`
    )
  }
  const diffs = files
    .filter((file) => file.before !== file.after)
    .map((file) =>
      buildDiffPreview({
        path: file.path,
        before: file.before ?? "",
        after: file.after ?? "",
        beforeRevision: file.beforeRevision,
      })
    )
  if (diffs.length === 0) throw new Error("no_op: patch would not change files")
  return {
    files,
    diffs,
    destructive: files.some(
      (file) => file.status === "deleted" || file.status === "moved"
    ),
  }
}

interface StagedFile {
  file: PlannedPatchFile
  staged?: string
  backup?: string
  existed: boolean
}

export async function commitPatch(
  env: Environment,
  planned: PlannedPatch
): Promise<
  | "ok"
  | { code: "stale_file"; path: string; current?: string }
  | { code: "commit_failed"; error: string }
  | { code: "rollback_failed"; error: string }
> {
  for (const file of planned.files) {
    const expected = file.beforeRevision
    const current = await readRevision(env, file.sourceTarget ?? file.target)
    if (current !== expected) {
      return { code: "stale_file", path: file.sourcePath ?? file.path, current }
    }
  }

  const staged: StagedFile[] = []
  try {
    for (const file of planned.files) {
      const existed = file.before !== undefined && file.status !== "moved"
      const entry: StagedFile = { file, existed }
      if (file.after !== undefined) {
        await env.mkdirp(dirname(file.target))
        entry.staged = makeTempPath(file.target)
        await env.writeFile(entry.staged, file.after)
      }
      if (existed) {
        entry.backup = makeTempPath(file.sourceTarget ?? file.target)
      }
      staged.push(entry)
    }

    for (const entry of staged) {
      if (entry.backup) {
        await env.rename(
          entry.file.sourceTarget ?? entry.file.target,
          entry.backup
        )
      }
    }
    for (const entry of staged) {
      if (entry.staged) {
        await env.rename(entry.staged, entry.file.target)
      }
    }
    for (const entry of staged) {
      if (entry.backup) await env.removeFile(entry.backup).catch(() => {})
    }
    return "ok"
  } catch (err) {
    const errors: string[] = []
    for (const entry of [...staged].reverse()) {
      if (entry.staged) await env.removeFile(entry.staged).catch(() => {})
      try {
        if (entry.backup) {
          await env.rename(
            entry.backup,
            entry.file.sourceTarget ?? entry.file.target
          )
        } else if (!entry.existed) {
          await env.removeFile(entry.file.target).catch(() => {})
        }
      } catch (rollbackErr) {
        errors.push(
          rollbackErr instanceof Error
            ? rollbackErr.message
            : String(rollbackErr)
        )
      }
    }
    if (errors.length > 0) {
      return {
        code: "rollback_failed",
        error: `${err instanceof Error ? err.message : String(err)}; rollback: ${errors.join("; ")}`,
      }
    }
    return {
      code: "commit_failed",
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
