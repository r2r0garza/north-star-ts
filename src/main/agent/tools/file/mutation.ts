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

export async function atomicWriteChecked(opts: {
  env: Environment
  target: string
  content: string
  expectedRevision?: string
}): Promise<"ok" | { staleRevision: string | null }> {
  const current = await readRevision(opts.env, opts.target)
  if (current !== opts.expectedRevision) {
    return { staleRevision: current ?? null }
  }

  const tmp = makeTempPath(opts.target)
  try {
    await opts.env.writeFile(tmp, opts.content)
    const beforeRename = await readRevision(opts.env, opts.target)
    if (beforeRename !== opts.expectedRevision) {
      return { staleRevision: beforeRename ?? null }
    }
    await opts.env.rename(tmp, opts.target)
    return "ok"
  } finally {
    await opts.env.removeFile(tmp).catch(() => {})
  }
}

export async function readRevision(
  env: Environment,
  target: string
): Promise<string | undefined> {
  try {
    return fileRevision(await env.readFile(target))
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
