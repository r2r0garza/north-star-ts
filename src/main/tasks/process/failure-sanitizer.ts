import type { FailureContext } from "../../db/types"
import { truncateUtf8Text } from "../../agent/tools/output"

export const FAILURE_MESSAGE_MAX_BYTES = 2048
export const FAILURE_CAUSE_MAX_BYTES = 4096

const REDACTED = "[redacted]"
const TRUNCATED = "[truncated]"

const SENSITIVE_KEY =
  "(?:authorization|cookie|x-api-key|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|token|password|secret|signature|sig)"

export function sanitizeFailureContext(
  failure: FailureContext
): FailureContext {
  return {
    ...failure,
    message: sanitizeFailureText(
      failure.message,
      FAILURE_MESSAGE_MAX_BYTES
    ),
    cause:
      failure.cause == null
        ? failure.cause
        : sanitizeFailureText(failure.cause, FAILURE_CAUSE_MAX_BYTES),
  }
}

export function sanitizeFailureText(text: string, maxBytes: number): string {
  const redacted = redactSensitiveFailureText(text)
  if (Buffer.byteLength(redacted, "utf8") <= maxBytes) return redacted

  const marker = `\n${TRUNCATED}: capped at ${maxBytes} bytes`
  const markerBytes = Buffer.byteLength(marker, "utf8")
  const bodyBudget = Math.max(0, maxBytes - markerBytes)
  const body = truncateUtf8Text(redacted, bodyBudget).text.trimEnd()
  return `${body}${marker}`
}

function redactSensitiveFailureText(text: string): string {
  let out = text

  out = out.replace(
    new RegExp(`\\b(${SENSITIVE_KEY})\\s*:\\s*Bearer\\s+[^\\s,;)}\\]]+`, "gi"),
    `$1: Bearer ${REDACTED}`
  )
  out = out.replace(
    new RegExp(
      `\\b(${SENSITIVE_KEY})\\s*[:=]\\s*(?!Bearer\\s+\\[redacted\\])([^\\s,;)}\\]]+)`,
      "gi"
    ),
    `$1=${REDACTED}`
  )
  out = out.replace(
    new RegExp(`(["'])(${SENSITIVE_KEY})\\1\\s*:\\s*(["'])(.*?)\\3`, "gi"),
    (_match, keyQuote, key, valueQuote) =>
      `${keyQuote}${key}${keyQuote}:${valueQuote}${REDACTED}${valueQuote}`
  )
  out = out.replace(
    /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    `Bearer ${REDACTED}`
  )
  out = out.replace(
    /\b(sk-[A-Za-z0-9_-]{8,}|pk-[A-Za-z0-9_-]{8,}|OPENAI_API_KEY[=:][^\s,;)}\]]+)/g,
    REDACTED
  )
  out = out.replace(
    /\b(?:response\s+body|provider\s+body|body|prompt|tool\s+(?:arguments?|results?))\s*[:=]\s*(?:```[\s\S]*?```|\{[\s\S]*\}|\[[\s\S]*\]|.+)$/gim,
    (_match) => `${REDACTED}`
  )
  out = out.replace(
    /(?:^|\s)(?:\/Users\/[^/\s]+|\/home\/[^/\s]+|\/private\/(?:var|tmp)|\/var\/folders\/[^/\s]+|[A-Za-z]:\\Users\\[^\\\s]+)(?:[^\s,;)}\]]*)/g,
    (match) => {
      const leading = match.match(/^\s/)?.[0] ?? ""
      return `${leading}${REDACTED}`
    }
  )

  return out
}
