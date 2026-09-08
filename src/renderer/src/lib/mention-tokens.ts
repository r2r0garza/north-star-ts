// Helpers for the composer's "mention" tokens — the literal text the user
// inserts by picking from a trigger menu:
//   - `/skill-name` (trigger `/`) steers the agent toward a skill
//   - `@path/to/file` (trigger `@`) points the agent at a workspace file
//
// Only mentions the user *explicitly selected* (tracked in per-kind confirmed
// sets) are treated specially — an arbitrary `/foo`, an email `a@b.com`, or a
// URL path stays plain text.
//
// Three jobs, both kinds handled in one pass:
//   - activeMentionToken: detect the trigger token being typed at the caret
//   - segmentMessage:     split text into plain + mention segments (badge overlay)
//   - expandMentions:     rewrite confirmed file tokens for the model (at send)

export type MentionKind = "skill" | "file"

type TriggerConfig = {
  kind: MentionKind
  trigger: string
  // Characters allowed inside the token as the user types. Skill names are
  // word chars + hyphens; file paths additionally allow `/` and `.`. We accept
  // a slightly loose set so the menu still opens for partial/mistyped queries.
  tokenChar: RegExp
}

const TRIGGERS: TriggerConfig[] = [
  { kind: "skill", trigger: "/", tokenChar: /[\w-]/ },
  { kind: "file", trigger: "@", tokenChar: /[\w\-./]/ },
]

// The mention markup for a kind: `/skill-name`, `@path`. Kept in one place so
// insertion, regex building, and expansion agree.
function marker(kind: MentionKind, value: string): string {
  return kind === "skill" ? `/${value}` : `@${value}`
}

export type MentionToken = {
  kind: MentionKind
  trigger: string
  // The text after the trigger, up to the caret — the menu's search query.
  query: string
  // Absolute offsets of the token (including the trigger char) within the text.
  start: number
  end: number
}

// Find the trigger token whose end is exactly at `caret`, if any. The trigger
// char must begin the token AND sit at the start of the string or after
// whitespace — so `a@b.com`, `https://a/b`, and `src/lib` never open a menu.
// Tries each trigger; the boundary rule disambiguates (e.g. in `@src/foo` the
// inner `/` fails the boundary check, so only the leading `@` matches).
export function activeMentionToken(
  text: string,
  caret: number
): MentionToken | null {
  for (const cfg of TRIGGERS) {
    let i = caret
    while (i > 0 && cfg.tokenChar.test(text[i - 1])) i--
    // `i` is the first token char; the char before it must be the trigger.
    const trigIndex = i - 1
    if (trigIndex < 0 || text[trigIndex] !== cfg.trigger) continue
    // And the trigger must be at the start or preceded by whitespace.
    if (trigIndex > 0 && !/\s/.test(text[trigIndex - 1])) continue
    return {
      kind: cfg.kind,
      trigger: cfg.trigger,
      query: text.slice(i, caret),
      start: trigIndex,
      end: caret,
    }
  }
  return null
}

// A confirmed set of values for one mention kind (skill names, or file paths).
export type ConfirmedMentions = {
  kind: MentionKind
  values: Set<string>
}

// Escape a string for literal use inside a RegExp.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Build one regexp matching every confirmed marker across all kinds, at a token
// boundary: preceded by whitespace or start-of-string, and not followed by
// another token char (so `/git` doesn't match inside `/git-commit`, and a file
// path isn't matched inside a longer path). Markers are sorted longest-first so
// overlapping values prefer the longer match. Capture group 1 is the full
// marker text. Returns null when nothing is confirmed.
function markerRegExp(confirmed: ConfirmedMentions[]): RegExp | null {
  const markers = confirmed.flatMap((c) =>
    [...c.values].map((v) => marker(c.kind, v))
  )
  if (markers.length === 0) return null
  const alt = markers
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|")
  // (?<![^\s]) = preceded by whitespace or start; (?![\w\-./]) = not mid-token.
  return new RegExp(`(?<![^\\s])(${alt})(?![\\w\\-./])`, "g")
}

// Map a matched marker back to its kind + value (the marker text is unique
// across kinds because the trigger char differs).
function classifyMarker(match: string): { kind: MentionKind; value: string } {
  return match[0] === "/"
    ? { kind: "skill", value: match.slice(1) }
    : { kind: "file", value: match.slice(1) }
}

export type MessageSegment = {
  text: string
  // When this segment is a confirmed mention token, its kind; else null.
  kind: MentionKind | null
}

// Split `text` into ordered segments so the overlay can tint confirmed mention
// tokens and leave everything else plain.
export function segmentMessage(
  text: string,
  confirmed: ConfirmedMentions[]
): MessageSegment[] {
  const re = markerRegExp(confirmed)
  if (!re) return text ? [{ text, kind: null }] : []
  const segments: MessageSegment[] = []
  let last = 0
  for (const m of text.matchAll(re)) {
    const start = m.index
    if (start > last)
      segments.push({ text: text.slice(last, start), kind: null })
    segments.push({ text: m[0], kind: classifyMarker(m[0]).kind })
    last = start + m[0].length
  }
  if (last < text.length) segments.push({ text: text.slice(last), kind: null })
  return segments
}

// Rewrite confirmed file mention tokens for the model:
//   - `/git-commit` stays literal; the main process validates selected skills
//     and deterministically pre-injects read_skill before inference.
//   - `@src/foo.ts` → `src/foo.ts` (the bare workspace-relative path, which is
//     what the agent's file tools consume)
export function expandMentions(
  text: string,
  confirmed: ConfirmedMentions[]
): string {
  const re = markerRegExp(confirmed)
  if (!re) return text
  return text.replace(re, (m) => {
    const { kind, value } = classifyMarker(m)
    return kind === "skill" ? m : value
  })
}
