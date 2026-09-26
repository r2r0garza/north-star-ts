// A user story's optional story: who benefits and why, as
// "As a <asA>, I want <iWant>, so that <soThat>." Technical work (a migration,
// a refactor) leaves it empty; the Goal stays the engineering objective either
// way, and acceptance criteria carry the checkable behavior.
export interface UserStoryNarrative {
  asA: string
  iWant: string
  soThat: string
}

function part(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

// Accepts the stored camelCase shape and the snake_case shape agents send.
// Null when every part is empty.
export function normalizeStory(value: unknown): UserStoryNarrative | null {
  if (!value || typeof value !== "object") return null
  const v = value as Record<string, unknown>
  const story = {
    asA: part(v.asA ?? v.as_a),
    iWant: part(v.iWant ?? v.i_want),
    soThat: part(v.soThat ?? v.so_that),
  }
  return story.asA || story.iWant || story.soThat ? story : null
}

function article(role: string): string {
  if (/^(a|an|the)\s/i.test(role)) return ""
  return /^[aeio]/i.test(role) ? "an " : "a "
}

function sentence(text: string): string {
  return text.replace(/[.\s]+$/, "")
}

export function formatStory(story: UserStoryNarrative): string {
  const parts = [
    story.asA && `As ${article(story.asA)}${sentence(story.asA)}`,
    story.iWant && `I want ${sentence(story.iWant)}`,
    story.soThat && `so that ${sentence(story.soThat)}`,
  ].filter(Boolean)
  const text = parts.join(", ")
  return `${text[0].toUpperCase()}${text.slice(1)}.`
}
