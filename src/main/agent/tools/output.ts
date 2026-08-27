// Shared helpers for tool output: truncation (so a huge file/grep can't blow
// the model's context window) and a consistent structured-error format (so the
// model gets machine-readable, actionable failures instead of ad-hoc strings).

// Default caps. Mirror the attachment byte cap used in agent/index.ts so tool
// output and inlined attachments are bounded consistently.
const DEFAULT_MAX_BYTES = 256 * 1024 // 256 KB
const DEFAULT_MAX_LINES = 2000

export interface TruncateOptions {
  maxBytes?: number
  maxLines?: number
  recoveryHint?: string
  metadata?: Record<string, unknown>
}

export interface TruncateResult {
  text: string
  truncated: boolean
  note?: string
}

export function utf8SafePrefix(
  text: string,
  maxBytes: number
): { text: string; bytes: number } {
  if (maxBytes <= 0) return { text: "", bytes: 0 }
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { text, bytes: Buffer.byteLength(text, "utf8") }
  }

  let bytes = 0
  let out = ""
  for (const char of text) {
    const next = Buffer.byteLength(char, "utf8")
    if (bytes + next > maxBytes) break
    out += char
    bytes += next
  }
  return { text: out, bytes }
}

export function truncateUtf8Text(
  text: string,
  maxBytes: number
): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { text, truncated: false }
  }

  const prefix = utf8SafePrefix(text, maxBytes).text
  const lastNl = prefix.lastIndexOf("\n")
  return {
    text: lastNl > 0 ? prefix.slice(0, lastNl) : prefix,
    truncated: true,
  }
}

function fitTextWithNote(text: string, note: string, maxBytes: number): string {
  const noteBytes = Buffer.byteLength(note, "utf8")
  if (noteBytes >= maxBytes) return utf8SafePrefix(note, maxBytes).text

  const separatorBytes = text.length > 0 ? 1 : 0
  const bodyBudget = Math.max(0, maxBytes - noteBytes - separatorBytes)
  const body = truncateUtf8Text(text, bodyBudget).text
  return body ? `${body}\n${note}` : note
}

// Cap `text` by both line count and byte size, whichever is hit first. When
// truncated, the returned `text` already has a trailing note appended telling
// the model how many lines/bytes it's seeing and how to get more.
export function truncateForModel(
  text: string,
  opts: TruncateOptions = {}
): TruncateResult {
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES

  const lines = text.split("\n")
  const totalLines = lines.length
  let kept = lines
  let truncated = false
  let reason = ""

  if (totalLines > maxLines) {
    kept = lines.slice(0, maxLines)
    truncated = true
    reason = `showing ${maxLines} of ${totalLines} lines`
  }

  let out = kept.join("\n")

  // Byte cap (UTF-8). Trim to a line boundary so we don't cut mid-line.
  if (Buffer.byteLength(out, "utf8") > maxBytes) {
    out = truncateUtf8Text(out, maxBytes).text
    truncated = true
    reason = reason
      ? `${reason}; also capped at ${maxBytes} bytes`
      : `capped at ${maxBytes} bytes`
  }

  if (!truncated) return { text: out, truncated: false }

  const metadata = opts.metadata ? ` ${JSON.stringify(opts.metadata)}` : ""
  const recovery = opts.recoveryHint ? ` — ${opts.recoveryHint}` : ""
  const note = `[truncated: ${reason}${recovery}${metadata}]`
  return { text: fitTextWithNote(out, note, maxBytes), truncated: true, note }
}

export function renderMetadata(metadata: Record<string, unknown>): string {
  return `[metadata] ${JSON.stringify(metadata)}`
}

// A consistent error format tools return for *expected* failures (file not
// found, ambiguous edit match, file too large, etc.). The `code` lets the model
// branch programmatically; the optional `hint` tells it how to recover.
export function toolError(
  code: string,
  message: string,
  hint?: string
): string {
  const base = `ERROR[${code}]: ${message}`
  return hint ? `${base} Hint: ${hint}` : base
}
