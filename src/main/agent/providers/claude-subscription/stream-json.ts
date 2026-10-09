import { object, protocol } from "./errors"

export class JsonLines {
  private decoder = new TextDecoder("utf-8", { fatal: true })
  private pending = ""
  constructor(private readonly emit: (event: Record<string, any>) => void) {}
  push(chunk: Uint8Array) {
    try {
      this.pending += this.decoder.decode(chunk, { stream: true })
    } catch {
      protocol()
    }
    this.drain(false)
  }
  finish() {
    try {
      this.pending += this.decoder.decode()
    } catch {
      protocol()
    }
    this.drain(true)
  }
  private drain(final: boolean) {
    while (this.pending.includes("\n")) {
      const index = this.pending.indexOf("\n")
      this.line(this.pending.slice(0, index))
      this.pending = this.pending.slice(index + 1)
    }
    if (Buffer.byteLength(this.pending) > 8 * 1024 * 1024) protocol()
    if (final && this.pending) {
      this.line(this.pending)
      this.pending = ""
    }
  }
  private line(line: string) {
    if (Buffer.byteLength(line) > 8 * 1024 * 1024 || !line.trim()) protocol()
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      protocol()
    }
    if (!object(event) || typeof event.type !== "string") protocol()
    this.emit(event)
  }
}
