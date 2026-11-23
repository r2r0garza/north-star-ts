import { StringDecoder } from "node:string_decoder"
import type { CommandChunk } from "../agent/env/types"
import type { KanbanCommandOutput } from "../../shared/kanban"

export const COMMAND_OUTPUT_BYTES = 64 * 1024
const RETAINED_RUNS = 100

// Live output is session-local; persisted result/error history remains in SQLite.
export class CommandOutputStore {
  private runs = new Map<string, KanbanCommandOutput>()
  private decoders = new Map<string, Map<string, StringDecoder>>()

  start(runId: string, command: string, cwd: string, queued = false): void {
    this.runs.set(runId, {
      runId,
      command,
      cwd,
      status: queued ? "queued" : "starting",
      output: "",
      omittedBytes: 0,
      exitCode: null,
      signal: null,
    })
    this.decoders.set(runId, new Map())
    this.prune()
  }

  get(runId: string): KanbanCommandOutput | null {
    const value = this.runs.get(runId)
    return value ? { ...value } : null
  }

  stop(runId: string, error: string): void {
    const run = this.runs.get(runId)
    if (run?.status === "queued")
      this.finish(runId, { status: "stopped", error })
    else if (run) Object.assign(run, { status: "stopped", error })
  }

  running(runId: string): void {
    const run = this.runs.get(runId)
    if (run?.status === "starting") run.status = "running"
  }

  append(runId: string, chunk: CommandChunk): void {
    const decoders = this.decoders.get(runId)
    if (!decoders) return
    let decoder = decoders.get(chunk.stream)
    if (!decoder) {
      decoder = new StringDecoder("utf8")
      decoders.set(chunk.stream, decoder)
    }
    this.appendText(runId, decoder.write(chunk.data))
  }

  private appendText(runId: string, text: string): void {
    const run = this.runs.get(runId)
    if (!run) return
    const bytes = Buffer.from(run.output + text)
    let cut = Math.max(0, bytes.length - COMMAND_OUTPUT_BYTES)
    while (cut < bytes.length && (bytes[cut] & 0xc0) === 0x80) cut++
    run.output = bytes.subarray(cut).toString("utf8")
    run.omittedBytes += cut
  }

  finish(
    runId: string,
    terminal: Pick<KanbanCommandOutput, "status"> & Partial<KanbanCommandOutput>
  ): void {
    const run = this.runs.get(runId)
    if (!run) return
    for (const decoder of this.decoders.get(runId)?.values() ?? []) {
      this.appendText(runId, decoder.end())
    }
    this.decoders.delete(runId)
    Object.assign(run, terminal)
    this.prune()
  }

  private prune(): void {
    for (const id of this.runs.keys()) {
      if (this.runs.size <= RETAINED_RUNS) break
      if (!this.decoders.has(id)) this.runs.delete(id)
    }
  }
}
