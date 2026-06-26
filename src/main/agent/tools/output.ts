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
}

export interface TruncateResult {
  text: string
  truncated: boolean
  note?: string
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
    const buf = Buffer.from(out, "utf8").subarray(0, maxBytes)
    let sliced = buf.toString("utf8")
    const lastNl = sliced.lastIndexOf("\n")
    if (lastNl > 0) sliced = sliced.slice(0, lastNl)
    out = sliced
    truncated = true
    reason = reason
      ? `${reason}; also capped at ${maxBytes} bytes`
      : `capped at ${maxBytes} bytes`
  }

  if (!truncated) return { text: out, truncated: false }

  const note = `[truncated: ${reason} — use read_file with offset to see more]`
  return { text: `${out}\n${note}`, truncated: true, note }
}

// A consistent error format tools return for *expected* failures (file not
// found, ambiguous edit match, file too large, etc.). The `code` lets the model
// branch programmatically; the optional `hint` tells it how to recover.
export function toolError(code: string, message: string, hint?: string): string {
  const base = `ERROR[${code}]: ${message}`
  return hint ? `${base} Hint: ${hint}` : base
}
