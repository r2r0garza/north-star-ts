import { createHash } from "crypto"
import { StringDecoder } from "string_decoder"
import type { FileHandle } from "fs/promises"
import type { ReadTextLinesOptions, ReadTextLinesResult } from "./types"

const BINARY_SNIFF_BYTES = 8000
const READ_CHUNK_BYTES = 64 * 1024

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
  handle: FileHandle,
  fileBytes: number,
  opts: ReadTextLinesOptions
): Promise<ReadTextLinesResult> {
  const offset = Math.max(1, Math.floor(opts.offset))
  const limit = Math.max(1, Math.floor(opts.limit))
  const maxBytes = Math.max(1, Math.floor(opts.maxBytes))

  let decoder = new StringDecoder("utf8")
  const hash = createHash("sha256")
  const lines: string[] = []
  const sniffed = Buffer.alloc(BINARY_SNIFF_BYTES)
  let pending = ""
  let sniffedBytes = 0
  let position = 0
  let currentLine = 1
  let endLine = 0
  let returnedBytes = 0
  let hasMore = false
  let truncated = false
  let lineTooLong = false
  let skippedLineRemainder = false
  let reachedEof = false
  let stoppedEarly = false

  const stop = () => {
    stoppedEarly = true
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

    const normalizedLine = line.endsWith("\r") ? line.slice(0, -1) : line
    const lineBytes = Buffer.byteLength(normalizedLine, "utf8")
    const separatorBytes = lines.length > 0 ? 1 : 0
    if (returnedBytes + separatorBytes + lineBytes > maxBytes) {
      truncated = true
      hasMore = true
      if (lines.length === 0) {
        const prefix = utf8Prefix(normalizedLine, maxBytes)
        lines.push(prefix)
        returnedBytes = Buffer.byteLength(prefix, "utf8")
        endLine = currentLine
        lineTooLong = true
        skippedLineRemainder = true
      }
      stop()
      return false
    }

    lines.push(normalizedLine)
    returnedBytes += separatorBytes + lineBytes
    endLine = currentLine
    currentLine += 1
    return true
  }

  const readNextChunk = async (): Promise<Buffer | null> => {
    opts.signal?.throwIfAborted()
    const targetLength = Math.min(READ_CHUNK_BYTES, fileBytes - position)
    if (targetLength <= 0) return null

    const buffer = Buffer.allocUnsafe(targetLength)
    const { bytesRead } = await handle.read(buffer, 0, targetLength, position)
    opts.signal?.throwIfAborted()
    if (bytesRead <= 0) return null
    position += bytesRead

    const chunk = buffer.subarray(0, bytesRead)
    hash.update(chunk)
    if (sniffedBytes < BINARY_SNIFF_BYTES) {
      const toCopy = Math.min(BINARY_SNIFF_BYTES - sniffedBytes, chunk.length)
      chunk.copy(sniffed, sniffedBytes, 0, toCopy)
      sniffedBytes += toCopy
      if (sniffed.subarray(0, sniffedBytes).includes(0)) {
        throw new Error("BINARY_FILE")
      }
    }
    return chunk
  }

  while (!stoppedEarly) {
    const buf = await readNextChunk()
    if (!buf) break

    if (skippedLineRemainder) {
      const raw = buf.toString("binary")
      const nl = raw.indexOf("\n")
      if (nl < 0) continue
      skippedLineRemainder = false
      pending = decoder.write(buf.subarray(nl + 1))
    } else {
      pending += decoder.write(buf)
    }

    while (!stoppedEarly) {
      const nl = pending.indexOf("\n")
      if (nl < 0) break
      const line = pending.slice(0, nl)
      pending = pending.slice(nl + 1)
      if (!maybeTakeLine(line)) break
    }

    if (!stoppedEarly && Buffer.byteLength(pending, "utf8") > maxBytes) {
      if (currentLine < offset) {
        pending = ""
        skippedLineRemainder = true
        decoder = new StringDecoder("utf8")
        currentLine += 1
      } else {
        maybeTakeLine(pending)
      }
    }
  }

  if (!stoppedEarly) {
    pending += decoder.end()
    if (!skippedLineRemainder && (pending.length > 0 || fileBytes === 0)) {
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
      fileBytes,
      truncated: false,
      revision: reachedEof ? hash.digest("hex") : undefined,
    }
  }

  return {
    text: lines.join("\n"),
    startLine: offset,
    endLine,
    hasMore,
    nextOffset: hasMore ? endLine + 1 : undefined,
    fileBytes,
    truncated,
    revision: reachedEof ? hash.digest("hex") : undefined,
    lineTooLong: lineTooLong || undefined,
    skippedLineRemainder: skippedLineRemainder || undefined,
  }
}
