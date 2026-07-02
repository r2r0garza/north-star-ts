import { createHash } from "crypto"
import { readFile } from "fs/promises"
import { join } from "path"
import { getWorkspace } from "../db/repositories/workspaces"
import {
  getRunByWorkspace,
  upsertRun,
  updateProgress,
  resetRun,
} from "../db/repositories/index-runs"
import {
  getFileByPath,
  upsertFiles,
  listPaths,
  listFilesByStage,
  setIndexedStage,
  deleteFile,
  deleteFilesByWorkspace,
  type UpsertFileInput,
} from "../db/repositories/index-files"
import {
  upsertMetadata,
  deleteMetadataByWorkspace,
} from "../db/repositories/index-metadata"
import { replaceSymbolsForFile } from "../db/repositories/index-symbols"
import { getTask } from "../db/repositories/tasks"
import {
  walkFiles,
  loadGitignore,
  isBinaryBuffer,
  type WalkedFile,
} from "../agent/env/walk"
import { classifyFile } from "./classify"
import { pickExtractor } from "./extractors"
import type { TaskRunner, TaskExecutor } from "../tasks/runner"
import type { IndexPriority } from "../db/types"
import {
  parseMetadataDoc,
  detectViteConfig,
  readGitBranch,
  METADATA_FILES,
} from "./metadata"

// Files above this are skipped from the index entirely (same spirit as search's
// cap: huge blobs are not worth hashing/parsing).
const MAX_FILE_BYTES = 2 * 1024 * 1024

// How many files to process before yielding the event loop + emitting progress.
const BATCH_SIZE = 200

// Inter-batch delay by priority: North Star (high) runs flat-out; Interactive
// (low) yields ~15ms between batches so background indexing never janks typing.
const BATCH_DELAY_MS: Record<IndexPriority, number> = { high: 0, low: 15 }

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

// Thrown internally to unwind the stage machine on pause/cancel. runOne maps the
// resulting {paused}/{stopped} to the right terminal status.
class AbortedError extends Error {}

// Drives the deterministic workspace index as a 009 durable task. No LLM in the
// build path — walk/hash/parse only. One IndexService per app, holding the runner
// reference so ensureRunning can enqueue the `workspace_index` kind.
export class IndexService {
  constructor(private readonly runner: TaskRunner) {}

  // The executor the runner invokes for the `workspace_index` kind. Registered at
  // app init: runner.registerKind("workspace_index", { autoResume: true, run }).
  readonly execute: TaskExecutor = async ({ task, signal, emit }) => {
    const input = task.input as {
      workspaceId?: string
      priority?: IndexPriority
    } | null
    const workspaceId = input?.workspaceId
    const priority = input?.priority ?? "low"
    if (!workspaceId)
      return { error: "workspace_index task missing workspaceId" }
    const ws = getWorkspace(workspaceId)
    if (!ws) return { error: "workspace not found" }

    try {
      await this.runStages({
        workspaceId,
        root: ws.path,
        priority,
        signal,
        emit,
      })
      upsertRun(workspaceId, { error: null })
      return { content: "index complete" }
    } catch (err) {
      if (err instanceof AbortedError || signal.aborted) {
        // Pause vs cancel is decided by runOne from the abort reason
        // (PAUSE_ABORT_REASON → paused, else cancelled). Either way the partial
        // index and per-batch cursor are already persisted, so resume continues.
        return { stopped: true }
      }
      const message = err instanceof Error ? err.message : String(err)
      upsertRun(workspaceId, { error: message })
      // Deterministic failures (bad parse, fs error) don't benefit from a retry.
      return { error: message, retryable: false }
    }
  }

  // Ensure a workspace has a live/queued index task. Idempotent: no-op if indexing
  // is disabled for the workspace or a task is already in flight. Otherwise mark
  // the run enabled at the given priority and enqueue a task, linking it back.
  ensureRunning(workspaceId: string, priority: IndexPriority): void {
    const ws = getWorkspace(workspaceId)
    if (!ws) return
    const run = getRunByWorkspace(workspaceId)
    if (run && !run.enabled) return
    if (run?.taskId) {
      const task = getTask(run.taskId)
      if (task && LIVE_STATUSES.has(task.status)) return
    }
    upsertRun(workspaceId, { enabled: true, priority })
    const task = this.runner.enqueueKind({
      kind: "workspace_index",
      title: `Indexing ${ws.name ?? ws.path}`,
      input: { workspaceId, priority },
    })
    upsertRun(workspaceId, { taskId: task.id })
  }

  // Clear a workspace's index entirely: drop all rows and reset the run to idle.
  // (The active task, if any, is cancelled by the IPC handler before this runs.)
  clear(workspaceId: string): void {
    deleteFilesByWorkspace(workspaceId)
    deleteMetadataByWorkspace(workspaceId)
    resetRun(workspaceId)
  }

  // Stage machine: file_map → metadata → symbols (embeddings deferred). Every
  // stage is idempotent and cheap on re-run — file_map is hash-skip incremental,
  // metadata is a handful of small parses, and symbols re-extracts only the
  // "dirty" files (those still at indexed_stage=file_map, i.e. new/changed) — so
  // every run (fresh trigger OR resume after pause/interrupt) runs all three from
  // the top and converges without a per-file resume cursor. `stage` is written
  // for the UI's benefit. A pause/cancel throws AbortedError out; partial state is
  // persisted per batch, so the next run continues from where it left off.
  private async runStages(ctx: {
    workspaceId: string
    root: string
    priority: IndexPriority
    signal: AbortSignal
    emit: (event: {
      type: "index_progress"
      stage: string
      filesScanned: number
      filesTotal: number
    }) => void
  }): Promise<void> {
    upsertRun(ctx.workspaceId, { stage: "file_map" })
    await this.stageFileMap(ctx)
    this.throwIfAborted(ctx.signal)
    upsertRun(ctx.workspaceId, { stage: "metadata" })
    await this.stageMetadata(ctx)
    this.throwIfAborted(ctx.signal)
    upsertRun(ctx.workspaceId, { stage: "symbols" })
    await this.stageSymbols(ctx)
  }

  // Stage 1: walk the tree, incrementally upsert changed/new files, drop deleted.
  private async stageFileMap(ctx: {
    workspaceId: string
    root: string
    priority: IndexPriority
    signal: AbortSignal
    emit: (event: {
      type: "index_progress"
      stage: string
      filesScanned: number
      filesTotal: number
    }) => void
  }): Promise<void> {
    const gitignore = await loadGitignore(ctx.root)
    const seen = new Set<string>()
    let batch: UpsertFileInput[] = []
    let scanned = 0

    const flush = async (): Promise<void> => {
      if (batch.length > 0) {
        upsertFiles(batch)
        batch = []
      }
      updateProgress(ctx.workspaceId, {
        filesScanned: scanned,
        filesTotal: scanned, // total only known once the walk finishes
        stage: "file_map",
        cursor: null,
      })
      ctx.emit({
        type: "index_progress",
        stage: "file_map",
        filesScanned: scanned,
        filesTotal: scanned,
      })
      await sleep(BATCH_DELAY_MS[ctx.priority])
      this.throwIfAborted(ctx.signal)
    }

    for await (const file of walkFiles({
      root: ctx.root,
      maxFileBytes: MAX_FILE_BYTES,
      gitignore,
      signal: ctx.signal,
    })) {
      this.throwIfAborted(ctx.signal)
      seen.add(file.relPath)
      scanned++
      const upsert = await this.classifyAndBuild(ctx.workspaceId, file)
      if (upsert) batch.push(upsert)
      if (batch.length >= BATCH_SIZE) await flush()
    }
    await flush()

    // Deletions: anything tracked but no longer walked.
    for (const path of listPaths(ctx.workspaceId)) {
      if (!seen.has(path)) deleteFile(ctx.workspaceId, path)
    }
    // Now the total is known and equals scanned (all walked files).
    updateProgress(ctx.workspaceId, {
      filesScanned: scanned,
      filesTotal: scanned,
      stage: "file_map",
    })
    ctx.emit({
      type: "index_progress",
      stage: "file_map",
      filesScanned: scanned,
      filesTotal: scanned,
    })
  }

  // Decide whether a walked file needs (re)indexing; return the row to upsert, or
  // null to skip. Only hashes when the (size, mtime) fast path misses.
  private async classifyAndBuild(
    workspaceId: string,
    file: WalkedFile
  ): Promise<UpsertFileInput | null> {
    const existing = getFileByPath(workspaceId, file.relPath)
    if (existing) {
      const stateBeforeHash = classifyFile(existing, {
        size: file.size,
        mtime: file.mtime,
      })
      if (stateBeforeHash === "unchanged") return null
    }
    // Stat differs (or brand new): hash to confirm a real change vs a touch.
    const hash = await this.hashFile(file.path)
    if (
      existing &&
      classifyFile(existing, { size: file.size, mtime: file.mtime, hash }) ===
        "unchanged"
    ) {
      // A touch that didn't change content — refresh stat so the fast path hits
      // next time, but no deeper re-index needed.
      return {
        workspaceId,
        path: file.relPath,
        ext: file.ext || null,
        size: file.size,
        mtime: file.mtime,
        hash,
        indexedStage: existing.indexedStage,
      }
    }
    return {
      workspaceId,
      path: file.relPath,
      ext: file.ext || null,
      size: file.size,
      mtime: file.mtime,
      hash,
      indexedStage: "file_map",
    }
  }

  private async hashFile(path: string): Promise<string> {
    const buf = await readFile(path)
    return createHash("sha1").update(buf).digest("hex")
  }

  // Stage 2: parse the known high-value docs into index_metadata (one row each).
  private async stageMetadata(ctx: {
    workspaceId: string
    root: string
    signal: AbortSignal
    emit: (event: {
      type: "index_progress"
      stage: string
      filesScanned: number
      filesTotal: number
    }) => void
  }): Promise<void> {
    updateProgress(ctx.workspaceId, { stage: "metadata" })
    for (const doc of METADATA_FILES) {
      this.throwIfAborted(ctx.signal)
      const parsed = await parseMetadataDoc(ctx.root, doc)
      if (parsed) {
        upsertMetadata({
          workspaceId: ctx.workspaceId,
          kind: doc.kind,
          path: parsed.path,
          value: parsed.value,
        })
      }
    }
    // vite config (presence-only) + git branch aren't file-parse docs.
    this.throwIfAborted(ctx.signal)
    const vite = await detectViteConfig(ctx.root)
    if (vite) {
      upsertMetadata({
        workspaceId: ctx.workspaceId,
        kind: "vite_config",
        path: vite.path,
        value: vite.value,
      })
    }
    const git = await readGitBranch(ctx.root)
    if (git) {
      upsertMetadata({
        workspaceId: ctx.workspaceId,
        kind: "git",
        path: git.path,
        value: git.value,
      })
    }
    const run = getRunByWorkspace(ctx.workspaceId)
    ctx.emit({
      type: "index_progress",
      stage: "metadata",
      filesScanned: run?.filesScanned ?? 0,
      filesTotal: run?.filesTotal ?? 0,
    })
  }

  // Stage 3: extract symbols/imports for the dirty files (those still at
  // indexed_stage=file_map — new or content-changed). Each file goes to the first
  // Extractor that supports() it; the returned symbols replace that file's rows,
  // and the file is bumped to indexed_stage=symbols so the next run skips it.
  // Binaries and lockfiles are skipped (no useful symbols). Batched + abortable.
  private async stageSymbols(ctx: {
    workspaceId: string
    root: string
    priority: IndexPriority
    signal: AbortSignal
    emit: (event: {
      type: "index_progress"
      stage: string
      filesScanned: number
      filesTotal: number
    }) => void
  }): Promise<void> {
    const dirty = listFilesByStage(ctx.workspaceId, "file_map")
    const total = dirty.length
    let done = 0
    for (const file of dirty) {
      this.throwIfAborted(ctx.signal)
      try {
        const buf = await readFile(join(ctx.root, file.path))
        // Skip binaries: no text to parse. Still bump the stage so we don't
        // re-open them every run.
        if (!isBinaryBuffer(buf)) {
          const ext = file.ext ?? ""
          const doc = pickExtractor({ relPath: file.path, ext }).extract({
            relPath: file.path,
            ext,
            content: buf.toString("utf8"),
          })
          replaceSymbolsForFile(ctx.workspaceId, file.id, doc.symbols)
        }
      } catch {
        // Unreadable/parse failure — skip this file's symbols but still advance
        // its stage so a persistently-bad file doesn't wedge every run.
      }
      setIndexedStage(file.id, "symbols")
      done++
      if (done % BATCH_SIZE === 0) {
        ctx.emit({
          type: "index_progress",
          stage: "symbols",
          filesScanned: done,
          filesTotal: total,
        })
        await sleep(BATCH_DELAY_MS[ctx.priority])
      }
    }
    ctx.emit({
      type: "index_progress",
      stage: "symbols",
      filesScanned: done,
      filesTotal: total,
    })
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new AbortedError()
  }
}

// Task statuses that mean "a run is already in flight" — ensureRunning won't
// enqueue a duplicate. `paused`/`interrupted` are resumable (user-driven), so
// they DON'T count as live: auto-index shouldn't force-restart a paused run.
const LIVE_STATUSES = new Set(["queued", "running", "waiting_for_approval"])
