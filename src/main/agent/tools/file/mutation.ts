import { createHash, randomUUID } from "crypto"
import { dirname, join } from "path"
import type { Environment } from "../../env/types"

export interface FileDiffPreview {
  path: string
  oldRevision?: string
  newRevision: string
  oldStartLine: number
  oldEndLine: number
  newStartLine: number
  newEndLine: number
  additions: number
  deletions: number
  truncated: boolean
  diff: string
}

const MAX_DIFF_LINES = 120
const MAX_DIFF_BYTES = 12 * 1024
const DIFF_CONTEXT_LINES = 3

export const MUTATION_SOURCE_LIMITS = {
  maxFileBytes: 1024 * 1024,
  maxTransactionBytes: 4 * 1024 * 1024,
} as const

export interface FileTooLarge {
  code: "file_too_large"
  path: string
  size: number
  limit: number
  scope: "file" | "transaction"
}

export class FileTooLargeError extends Error implements FileTooLarge {
  readonly code = "file_too_large"

  constructor(
    readonly path: string,
    readonly size: number,
    readonly limit: number,
    readonly scope: "file" | "transaction" = "file"
  ) {
    super(
      fileTooLargeMessage({ code: "file_too_large", path, size, limit, scope })
    )
  }
}

export function fileTooLargeMessage(error: FileTooLarge): string {
  const subject =
    error.scope === "transaction" ? "Patch source files total" : "Source file"
  return `${subject} for ${error.path} is ${error.size} bytes, above the supported ${error.limit} byte limit. Use read_file_tool to inspect bounded ranges, then split the mutation into smaller files or use a streaming large-file workflow.`
}

export function fileRevision(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

export function revisionOfText(text: string): string {
  return fileRevision(Buffer.from(text, "utf8"))
}

export function validRevision(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  return /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : undefined
}

export function makeTempPath(target: string): string {
  return join(dirname(target), `.north-star-${randomUUID()}.tmp`)
}

export function isNotFoundError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === "ENOENT" || code === "ENOTDIR") return true
  const message = error instanceof Error ? error.message : String(error)
  return /\bENOENT\b|no such file|not found/i.test(message)
}

export type CleanupPhase = "staging" | "success" | "rollback"

export interface CleanupError {
  phase: CleanupPhase
  path: string
  filePath: string
  error: string
}

export function cleanupMessage(cleanupErrors?: CleanupError[]): string {
  if (!cleanupErrors || cleanupErrors.length === 0) return ""
  return ` Cleanup failed for retained paths: ${cleanupErrors
    .map(
      (error) =>
        `${error.path} (${error.phase} cleanup for ${error.filePath}: ${error.error})`
    )
    .join("; ")}.`
}

export async function removeCleanupFile(
  env: Environment,
  cleanupErrors: CleanupError[],
  phase: CleanupPhase,
  path: string,
  filePath: string
): Promise<void> {
  try {
    await env.removeFile(path)
  } catch (error) {
    if (isNotFoundError(error)) return
    cleanupErrors.push({
      phase,
      path,
      filePath,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

type FileTooLargeWithCleanup = FileTooLarge & {
  cleanupErrors?: CleanupError[]
}

export type AtomicWriteResult =
  | "ok"
  | { staleRevision: string | null; cleanupErrors?: CleanupError[] }
  | FileTooLargeWithCleanup
  | { code: "commit_failed"; error: string; cleanupErrors?: CleanupError[] }
  | { code: "cleanup_failed"; committed: true; cleanupErrors: CleanupError[] }

export async function atomicWriteChecked(opts: {
  env: Environment
  target: string
  path?: string
  content: string
  expectedRevision?: string
}): Promise<AtomicWriteResult> {
  const displayPath = opts.path ?? opts.target
  const cleanupErrors: CleanupError[] = []
  const current = await readRevision(opts.env, opts.target)
  if (current !== opts.expectedRevision) {
    return { staleRevision: current ?? null }
  }
  const originalMode =
    opts.expectedRevision === undefined
      ? undefined
      : await readFileMode(opts.env, opts.target)

  const tmp = makeTempPath(opts.target)
  let backup: string | undefined
  let backedUp = false
  let committed = false
  let cleanupComplete = false
  async function cleanupUncommitted(): Promise<void> {
    if (cleanupComplete) return
    cleanupComplete = true
    await removeCleanupFile(
      opts.env,
      cleanupErrors,
      "rollback",
      tmp,
      displayPath
    )
    if (backup && backedUp) {
      const current = await readRevision(opts.env, opts.target).catch(
        () => null
      )
      if (current === undefined) {
        try {
          await opts.env.rename(backup, opts.target)
          backedUp = false
        } catch (rollbackError) {
          cleanupErrors.push({
            phase: "rollback",
            path: backup,
            filePath: displayPath,
            error:
              rollbackError instanceof Error
                ? rollbackError.message
                : String(rollbackError),
          })
        }
      } else {
        await removeCleanupFile(
          opts.env,
          cleanupErrors,
          "rollback",
          backup,
          displayPath
        )
        backedUp = false
      }
    }
  }

  async function stale(staleRevision: string | null) {
    await cleanupUncommitted()
    return {
      staleRevision,
      ...(cleanupErrors.length > 0 ? { cleanupErrors } : {}),
    }
  }

  try {
    await opts.env.writeFile(tmp, opts.content)
    if (originalMode !== undefined) {
      await opts.env.chmod(tmp, originalMode)
    }
    const beforeRename = await readRevision(opts.env, opts.target)
    if (beforeRename !== opts.expectedRevision) {
      return stale(beforeRename ?? null)
    }
    if (originalMode !== undefined) {
      const beforeRenameMode = await readFileMode(opts.env, opts.target)
      if (beforeRenameMode !== originalMode) {
        return stale(beforeRename ?? null)
      }
    }
    if (!opts.env.installFileNoReplace) {
      return stale(beforeRename ?? null)
    }
    if (opts.expectedRevision === undefined) {
      try {
        await opts.env.installFileNoReplace(tmp, opts.target)
        committed = true
        await removeCleanupFile(
          opts.env,
          cleanupErrors,
          "success",
          tmp,
          displayPath
        )
        return cleanupErrors.length > 0
          ? { code: "cleanup_failed", committed: true, cleanupErrors }
          : "ok"
      } catch {
        let staleRevision: string | null = null
        try {
          staleRevision = (await readRevision(opts.env, opts.target)) ?? null
        } catch (error) {
          if (error instanceof FileTooLargeError) {
            await cleanupUncommitted()
            return {
              ...error,
              ...(cleanupErrors.length > 0 ? { cleanupErrors } : {}),
            }
          }
          staleRevision = null
        }
        return stale(staleRevision)
      }
    }
    backup = makeTempPath(opts.target)
    await opts.env.rename(opts.target, backup)
    backedUp = true
    const backedUpRevision = await readRevision(opts.env, backup)
    if (backedUpRevision !== opts.expectedRevision) {
      return stale(backedUpRevision ?? null)
    }
    if (originalMode !== undefined) {
      const backedUpMode = await readFileMode(opts.env, backup)
      if (backedUpMode !== originalMode) {
        return stale(backedUpRevision ?? null)
      }
    }
    try {
      await opts.env.installFileNoReplace(tmp, opts.target)
      committed = true
    } catch {
      let staleRevision: string | null = null
      try {
        staleRevision = (await readRevision(opts.env, opts.target)) ?? null
      } catch (error) {
        if (error instanceof FileTooLargeError) {
          await cleanupUncommitted()
          return {
            ...error,
            ...(cleanupErrors.length > 0 ? { cleanupErrors } : {}),
          }
        }
        staleRevision = null
      }
      return stale(staleRevision)
    }
    await removeCleanupFile(
      opts.env,
      cleanupErrors,
      "success",
      tmp,
      displayPath
    )
    await removeCleanupFile(
      opts.env,
      cleanupErrors,
      "success",
      backup,
      displayPath
    )
    backedUp = false
    return cleanupErrors.length > 0
      ? { code: "cleanup_failed", committed: true, cleanupErrors }
      : "ok"
  } catch (error) {
    await cleanupUncommitted()
    return {
      code: "commit_failed",
      error: error instanceof Error ? error.message : String(error),
      ...(cleanupErrors.length > 0 ? { cleanupErrors } : {}),
    }
  } finally {
    if (!cleanupComplete && !committed) {
      await cleanupUncommitted()
    }
    if (backup && backedUp && committed) {
      const retainedBackup = backup
      const current = await readRevision(opts.env, opts.target).catch(
        () => null
      )
      if (current === undefined) {
        await opts.env.rename(retainedBackup, opts.target).catch((error) => {
          cleanupErrors.push({
            phase: "rollback",
            path: retainedBackup,
            filePath: displayPath,
            error: error instanceof Error ? error.message : String(error),
          })
        })
      } else {
        await removeCleanupFile(
          opts.env,
          cleanupErrors,
          committed ? "success" : "rollback",
          retainedBackup,
          displayPath
        )
      }
    }
  }
}

export async function readRevision(
  env: Environment,
  target: string,
  displayPath = target,
  maxBytes = MUTATION_SOURCE_LIMITS.maxFileBytes
): Promise<string | undefined> {
  try {
    const info = await env.stat(target)
    if (!info.isFile()) return undefined
    if (info.size > maxBytes) {
      throw new FileTooLargeError(displayPath, info.size, maxBytes)
    }
    return fileRevision(await env.readFile(target))
  } catch (error) {
    if (error instanceof FileTooLargeError) throw error
    if (!isNotFoundError(error)) throw error
    return undefined
  }
}

export async function readFileMode(
  env: Environment,
  target: string
): Promise<number | undefined> {
  try {
    const info = await env.stat(target)
    return info.isFile() && info.mode !== undefined
      ? info.mode & 0o7777
      : undefined
  } catch {
    return undefined
  }
}

type DiffOp =
  | { kind: "same"; line: string }
  | { kind: "delete"; line: string }
  | { kind: "add"; line: string }

export function buildDiffPreview(opts: {
  path: string
  before: string
  after: string
  beforeRevision?: string
}): FileDiffPreview {
  const beforeLines = splitLines(opts.before)
  const afterLines = splitLines(opts.after)
  const ops = diffLines(beforeLines, afterLines)
  const changedIndexes = ops
    .map((op, i) => (op.kind === "same" ? -1 : i))
    .filter((i) => i >= 0)
  const additions = ops.filter((op) => op.kind === "add").length
  const deletions = ops.filter((op) => op.kind === "delete").length
  const firstChange = changedIndexes[0] ?? 0
  const lastChange = changedIndexes[changedIndexes.length - 1] ?? -1
  const hunkStart = Math.max(0, firstChange - DIFF_CONTEXT_LINES)
  const hunkEnd = Math.min(ops.length, lastChange + DIFF_CONTEXT_LINES + 1)
  const hunkOps = ops.slice(hunkStart, hunkEnd)
  const oldStartLine = countOldLines(ops.slice(0, hunkStart)) + 1
  const newStartLine = countNewLines(ops.slice(0, hunkStart)) + 1
  const oldLineCount = countOldLines(hunkOps)
  const newLineCount = countNewLines(hunkOps)
  const oldEndLine = Math.max(oldStartLine, oldStartLine + oldLineCount - 1)
  const newEndLine = Math.max(newStartLine, newStartLine + newLineCount - 1)

  let lines = [
    `--- a/${opts.path}`,
    `+++ b/${opts.path}`,
    `@@ -${oldStartLine},${oldLineCount} +${newStartLine},${newLineCount} @@`,
    ...hunkOps.map((op) =>
      op.kind === "same"
        ? ` ${op.line}`
        : op.kind === "add"
          ? `+${op.line}`
          : `-${op.line}`
    ),
  ]

  let truncated = false
  if (lines.length > MAX_DIFF_LINES) {
    lines = lines.slice(0, MAX_DIFF_LINES)
    truncated = true
  }
  let diff = lines.join("\n")
  if (Buffer.byteLength(diff, "utf8") > MAX_DIFF_BYTES) {
    const buf = Buffer.from(diff, "utf8").subarray(0, MAX_DIFF_BYTES)
    diff = buf.toString("utf8")
    const lastNl = diff.lastIndexOf("\n")
    if (lastNl > 0) diff = diff.slice(0, lastNl)
    truncated = true
  }
  if (truncated) diff += "\n...[diff truncated]"

  return {
    path: opts.path,
    oldRevision: opts.beforeRevision,
    newRevision: revisionOfText(opts.after),
    oldStartLine,
    oldEndLine,
    newStartLine,
    newEndLine,
    additions,
    deletions,
    truncated,
    diff,
  }
}

function splitLines(text: string): string[] {
  if (text === "") return []
  return text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n")
}

function countOldLines(ops: DiffOp[]): number {
  return ops.filter((op) => op.kind !== "add").length
}

function countNewLines(ops: DiffOp[]): number {
  return ops.filter((op) => op.kind !== "delete").length
}

function diffLines(a: string[], b: string[]): DiffOp[] {
  if (a.length * b.length > 1_000_000) return coarseDiffLines(a, b)

  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    Array(b.length + 1).fill(0)
  )
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: "same", line: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: "delete", line: a[i++] })
    } else {
      ops.push({ kind: "add", line: b[j++] })
    }
  }
  while (i < a.length) ops.push({ kind: "delete", line: a[i++] })
  while (j < b.length) ops.push({ kind: "add", line: b[j++] })
  return ops
}

function coarseDiffLines(a: string[], b: string[]): DiffOp[] {
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix++
  }

  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++
  }

  return [
    ...a.slice(0, prefix).map((line) => ({ kind: "same" as const, line })),
    ...a
      .slice(prefix, a.length - suffix)
      .map((line) => ({ kind: "delete" as const, line })),
    ...b
      .slice(prefix, b.length - suffix)
      .map((line) => ({ kind: "add" as const, line })),
    ...a.slice(a.length - suffix).map((line) => ({
      kind: "same" as const,
      line,
    })),
  ]
}
