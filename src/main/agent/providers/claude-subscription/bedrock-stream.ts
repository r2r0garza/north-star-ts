import { protocol } from "./errors"
import { ResponseCapture } from "./sse"

export function eventStreamCrc(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

export class BedrockCapture {
  private pending = Buffer.alloc(0)
  private bytes = 0
  private capture: ResponseCapture
  constructor(emit?: (kind: "text" | "reasoning", text: string) => void) {
    this.capture = new ResponseCapture(emit)
  }
  push(chunk: Uint8Array) {
    this.bytes += chunk.byteLength
    if (this.bytes > 32 * 1024 * 1024) protocol()
    this.pending = Buffer.concat([this.pending, chunk])
    while (this.pending.length >= 12) {
      const length = this.pending.readUInt32BE(0)
      const headerLength = this.pending.readUInt32BE(4)
      if (length < 16 || length > 1024 * 1024 || headerLength > length - 16)
        protocol()
      if (
        eventStreamCrc(this.pending.subarray(0, 8)) !==
        this.pending.readUInt32BE(8)
      )
        protocol()
      if (this.pending.length < length) return
      const frame = this.pending.subarray(0, length)
      if (
        eventStreamCrc(frame.subarray(0, -4)) !== frame.readUInt32BE(length - 4)
      )
        protocol()
      const headers: Record<string, string> = {}
      let offset = 12
      const end = 12 + headerLength
      while (offset < end) {
        const nameLength = frame[offset++]
        if (!nameLength || offset + nameLength + 3 > end) protocol()
        const name = frame.toString("utf8", offset, offset + nameLength)
        offset += nameLength
        if (frame[offset++] !== 7) protocol()
        const valueLength = frame.readUInt16BE(offset)
        offset += 2
        if (offset + valueLength > end || Object.hasOwn(headers, name))
          protocol()
        headers[name] = frame.toString("utf8", offset, offset + valueLength)
        offset += valueLength
      }
      if (
        headers[":message-type"] !== "event" ||
        headers[":event-type"] !== "chunk"
      )
        protocol()
      let payload: any
      try {
        payload = JSON.parse(frame.toString("utf8", end, length - 4))
      } catch {
        protocol()
      }
      if (
        typeof payload?.bytes !== "string" ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(payload.bytes)
      )
        protocol()
      const data = Buffer.from(payload.bytes, "base64")
      // Validate JSON before adding an SSE envelope; response authority remains in ResponseCapture.
      try {
        JSON.parse(data.toString("utf8"))
      } catch {
        protocol()
      }
      this.capture.push(
        Buffer.concat([Buffer.from("data: "), data, Buffer.from("\n\n")])
      )
      this.pending = this.pending.subarray(length)
    }
  }
  finish() {
    if (this.pending.length) protocol()
    return this.capture.finish()
  }
}
