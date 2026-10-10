import { eventStreamCrc } from "../bedrock-stream"

export function bedrockFrame(event: unknown): Buffer {
  const headers = Object.entries({
    ":message-type": "event",
    ":event-type": "chunk",
    ":content-type": "application/json",
  }).map(([name, value]) => {
    const n = Buffer.from(name),
      v = Buffer.from(value)
    const prefix = Buffer.alloc(1 + n.length + 3)
    prefix[0] = n.length
    n.copy(prefix, 1)
    prefix[1 + n.length] = 7
    prefix.writeUInt16BE(v.length, 2 + n.length)
    return Buffer.concat([prefix, v])
  })
  const h = Buffer.concat(headers)
  const payload = Buffer.from(
    JSON.stringify({
      bytes: Buffer.from(JSON.stringify(event)).toString("base64"),
    })
  )
  const frame = Buffer.alloc(16 + h.length + payload.length)
  frame.writeUInt32BE(frame.length, 0)
  frame.writeUInt32BE(h.length, 4)
  frame.writeUInt32BE(eventStreamCrc(frame.subarray(0, 8)), 8)
  h.copy(frame, 12)
  payload.copy(frame, 12 + h.length)
  frame.writeUInt32BE(eventStreamCrc(frame.subarray(0, -4)), frame.length - 4)
  return frame
}
