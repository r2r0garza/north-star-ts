// Incremental classification of a walked file against what the index already has
// — the core of cheap re-runs. Pure (no I/O) so it's exhaustively unit-testable.
//
//   new       — tracked by the walk, absent from the index → index it
//   deleted    — in the index, absent from the walk → drop its rows
//   unchanged  — same (size, mtime), OR same content hash → skip (no re-index)
//   changed    — differs by both stat and hash → re-index that file only
//
// The (size, mtime) fast path means an unchanged file is classified without ever
// hashing; a hash is only computed when stat differs, and even then a matching
// hash downgrades to `unchanged` (e.g. a touch that didn't change content).
export type FileState = "new" | "changed" | "unchanged" | "deleted"

export interface IndexedStat {
  size: number
  mtime: number
  hash: string
}

export interface WalkedStat {
  size: number
  mtime: number
  // The freshly computed content hash. Omit for the cheap stat-only first pass:
  // when (size, mtime) already match the index the caller skips hashing entirely.
  hash?: string
}

export function classifyFile(
  existing: IndexedStat | undefined,
  walked: WalkedStat | undefined
): FileState {
  if (!existing && !walked) return "unchanged" // nonsensical input; treat as no-op
  if (!existing) return "new"
  if (!walked) return "deleted"
  if (existing.size === walked.size && existing.mtime === walked.mtime) {
    return "unchanged"
  }
  // Stat differs — a hash is needed to tell a real edit from a mere touch.
  if (walked.hash !== undefined && walked.hash === existing.hash) return "unchanged"
  return "changed"
}
