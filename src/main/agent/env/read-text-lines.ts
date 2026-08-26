import { createHash } from "crypto"
import { createReadStream } from "fs"
import { StringDecoder } from "string_decoder"
import { stat } from "fs/promises"
import type { ReadTextLinesOptions, ReadTextLinesResult } from "./types"

const BINARY_SNIFF_BYTES = 8000

function utf8Prefix(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text
  let out = ""
  let bytes = 0
  for (const char of text) {
    const next = Buffer.byteLength(char, "utf8")
    if (bytes + next > maxBytes) break
    out += char
    bytes += next
  }
  return out
}

export async function readHostTextLines(
  path: string,
  opts: ReadTextLinesOptions
): Promise<ReadTextLinesResult> {
  const info = await stat(path)
  const offset = Math.max(1, Math.floor(opts.offset))
  const limit = Math.max(1, Math.floor(opts.limit))
  const maxBytes = Math.max(1, Math.floor(opts.maxBytes))

  const stream = createReadStream(path)
  const decoder = new StringDecoder("utf8")
  const hash = createHash("sha256")
  const lines: string[] = []
  let sniffed = Buffer.alloc(0)
  let pending = ""
  let currentLine = 1
  let endLine = 0
  let returnedBytes = 0
  let hasMore = false
  let truncated = false
  let lineTooLong = false
  let reachedEof = false
  let stoppedEarly = false

  const stop = () => {
    stoppedEarly = true
    stream.destroy()
  }

  const maybeTakeLine = (line: string): boolean => {
    if (currentLine < offset) {
      currentLine += 1
      return true
    }

    if (lines.length >= limit) {
      hasMore = true
      stop()
      return false
    }

    const lineBytes = Buffer.byteLength(line, "utf8")
    const separatorBytes = lines.length > 0 ? 1 : 0
    if (returnedBytes + separatorBytes + lineBytes > maxBytes) {
      truncated = true
      hasMore = true
      if (lines.length === 0) {
        const prefix = utf8Prefix(line, maxBytes)
        lines.push(prefix)
        returnedBytes = Buffer.byteLength(prefix, "utf8")
        endLine = currentLine
        lineTooLong = true
      }
      stop()
      return false
    }

    lines.push(line)
    returnedBytes += separatorBytes + lineBytes
    endLine = currentLine
    currentLine += 1
    return true
  }

  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      hash.update(buf)
      if (sniffed.length < BINARY_SNIFF_BYTES) {
        sniffed = Buffer.concat([
          sniffed,
          buf.subarray(0, BINARY_SNIFF_BYTES - sniffed.length),
        ])
        if (sniffed.includes(0)) {
          throw new Error("BINARY_FILE")
        }
      }

      pending += decoder.write(buf)
      while (true) {
        const nl = pending.indexOf("\n")
        if (nl < 0) break
        const line = pending.slice(0, nl)
        pending = pending.slice(nl + 1)
        if (!maybeTakeLine(line)) break
      }
      if (!stoppedEarly && Buffer.byteLength(pending, "utf8") > maxBytes) {
        if (currentLine < offset) {
          pending = ""
        } else {
          maybeTakeLine(pending)
        }
      }
      if (stoppedEarly) break
    }
  } catch (error) {
    if ((error as Error).message === "BINARY_FILE") throw error
    if (!stoppedEarly) throw error
  }

  if (!stoppedEarly) {
    pending += decoder.end()
    if (pending.length > 0 || info.size === 0) {
      maybeTakeLine(pending)
    }
    reachedEof = !stoppedEarly
  }

  if (lines.length === 0) {
    return {
      text: "",
      startLine: offset,
      endLine: offset - 1,
      hasMore: false,
      fileBytes: info.size,
      truncated: false,
      revision: reachedEof ? hash.digest("hex") : undefined,
    }
  }

  return {
    text: lines.join("\n"),
    startLine: offset,
    endLine,
    hasMore,
    nextOffset: hasMore ? endLine + (lineTooLong ? 0 : 1) : undefined,
    fileBytes: info.size,
    truncated,
    revision: reachedEof ? hash.digest("hex") : undefined,
    lineTooLong: lineTooLong || undefined,
  }
}
