// Helpers for the composer's `/skill` tokens. A "skill token" is the literal
// text `/skill-name` the user inserts by picking a skill from the slash menu.
// Only skills the user *explicitly selected* (tracked in a `confirmedSkills`
// set) are treated specially — an arbitrary `/foo` or a URL path stays plain.
//
// Three jobs:
//   - activeSlashToken: detect the `/word` being typed at the caret (drives the menu)
//   - segmentMessage:  split text into plain + skill segments (drives the badge overlay)
//   - expandSkillTokens: rewrite confirmed tokens to natural language (at send)

// Characters allowed inside a slash token as the user types. Skill names are
// lowercase-alphanumeric + hyphens, but we accept any word char while typing so
// the menu still opens for partial/mistyped queries.
const TOKEN_CHAR = /[\w-]/

export type SlashToken = {
  // The text after the `/`, up to the caret — the menu's search query.
  query: string
  // Absolute offsets of the token (including the leading `/`) within the text.
  start: number
  end: number
}

// Find the `/word` token whose end is exactly at `caret`, if any. The token
// must begin at the start of the string or be preceded by whitespace, so
// slashes inside URLs/paths (e.g. `https://a/b`) never trigger the menu.
// Returns null when the caret isn't sitting in such a token.
export function activeSlashToken(
  text: string,
  caret: number
): SlashToken | null {
  let i = caret
  while (i > 0 && TOKEN_CHAR.test(text[i - 1])) i--
  // `i` is now the first token char; the char before it must be a `/`.
  const slashIndex = i - 1
  if (slashIndex < 0 || text[slashIndex] !== "/") return null
  // And the `/` itself must be at the start or preceded by whitespace.
  if (slashIndex > 0 && !/\s/.test(text[slashIndex - 1])) return null
  return { query: text.slice(i, caret), start: slashIndex, end: caret }
}

// Escape a string for literal use inside a RegExp.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Build a regexp matching `/name` for any confirmed skill, at a token boundary:
// preceded by whitespace or start-of-string, and not followed by another token
// char (so `/git-commit` matches but `/git-commit-extra` does not). Names are
// sorted longest-first so overlapping names prefer the longer match.
function skillTokenRegExp(confirmed: Set<string>): RegExp | null {
  if (confirmed.size === 0) return null
  const alt = [...confirmed]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|")
  // (?<![^\s]) = preceded by whitespace or start; (?![\w-]) = not mid-token.
  return new RegExp(`(?<![^\\s])/(${alt})(?![\\w-])`, "g")
}

export type MessageSegment = {
  text: string
  // The skill name when this segment is a confirmed `/skill` token, else null.
  skill: string | null
}

// Split `text` into ordered segments so the overlay can tint confirmed skill
// tokens and leave everything else plain.
export function segmentMessage(
  text: string,
  confirmed: Set<string>
): MessageSegment[] {
  const re = skillTokenRegExp(confirmed)
  if (!re) return text ? [{ text, skill: null }] : []
  const segments: MessageSegment[] = []
  let last = 0
  for (const m of text.matchAll(re)) {
    const start = m.index
    if (start > last)
      segments.push({ text: text.slice(last, start), skill: null })
    segments.push({ text: m[0], skill: m[1] })
    last = start + m[0].length
  }
  if (last < text.length) segments.push({ text: text.slice(last), skill: null })
  return segments
}

// Rewrite confirmed `/name` tokens into natural language for the model, e.g.
// `…with the /git-commit` → `…with the git-commit skill`. Note the token
// expands to just `{name} skill` (no leading "the") so it reads correctly when
// the user has already written "the" before it.
export function expandSkillTokens(
  text: string,
  confirmed: Set<string>
): string {
  const re = skillTokenRegExp(confirmed)
  if (!re) return text
  return text.replace(re, (_m, name: string) => `${name} skill`)
}
