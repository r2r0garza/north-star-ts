import { createHash } from "crypto"

export type BrowserInteractionKind =
  | "navigation"
  | "reversible_interaction"
  | "consequential_commit"

export interface BrowserRefMetadata {
  ref: string
  target: string
  url: string
  origin: string
}

const COMMIT_TARGET_RE =
  /\b(delete|remove|destroy|purge|submit|send|publish|deploy|ship|purchase|buy|order|pay|checkout|subscribe|unsubscribe|invite|share|grant|authorize|allow|approve|accept|confirm|save|merge|transfer|withdraw|refund|archive|disable|enable|revoke|disconnect|connect)\b/i

export function browserOrigin(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.origin === "null" ? parsed.protocol : parsed.origin
  } catch {
    return url || "unknown origin"
  }
}

export function classifyBrowserClickTarget(
  target: string
): BrowserInteractionKind {
  return COMMIT_TARGET_RE.test(target)
    ? "consequential_commit"
    : "reversible_interaction"
}

export function summarizeBrowserPayload(text: string): string {
  const redacted = text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/\bhttps?:\/\/\S+/gi, "[url]")
    .replace(
      /\b(?:sk|pk|rk|ghp|github_pat|xox[baprs])_[A-Za-z0-9_-]+\b/g,
      "[secret]"
    )
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[secret]")
  const compact = redacted.replace(/\s+/g, " ").trim()
  const preview =
    compact.length > 80 ? `${compact.slice(0, 77).trimEnd()}...` : compact
  return `${preview || "(empty)"} (${text.length} char${text.length === 1 ? "" : "s"})`
}

export function hashBrowserPayload(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

export function browserActionIdentity(input: {
  action:
    | "click"
    | "type"
    | "type_submit"
    | "hover"
    | "drag"
    | "wait"
    | "dialog"
  url: string
  origin: string
  target: string
  ref?: string
  targetFingerprint?: string
  payloadHash?: string
}): string {
  const parts = [
    `browser_${input.action}`,
    input.origin,
    input.url || "unknown url",
    input.target,
  ]
  if (input.ref) parts.push(`ref=${input.ref}`)
  if (input.targetFingerprint) {
    parts.push(`target=${input.targetFingerprint}`)
  }
  if (input.payloadHash) parts.push(`payload_sha256=${input.payloadHash}`)
  return parts.join(":")
}
