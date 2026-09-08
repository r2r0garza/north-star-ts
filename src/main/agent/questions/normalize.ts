import type { Question, QuestionAnswer } from "../tools/types"

// Bounds — keep the panel sane and the schema honest. The UI always appends a
// free-form "Other" choice, so the model never specifies it.
export const MAX_QUESTIONS = 4
export const MIN_OPTIONS = 2
export const MAX_OPTIONS = 4

// Model-facing copy for the INTERNAL tool. The CLI bridge deliberately ships its
// own wording (mcp-server/tools/ask-user-question.ts): inside runAgentLoop this
// tool is the only way to reach the user, so "don't overuse it" is the right
// steer, whereas a CLI can always just ask in prose and needs the opposite push.
// The schema, bounds, and answer shape below stay shared.
export const ASK_USER_QUESTION_DESCRIPTION =
  "Ask the user one or more clarifying questions when you genuinely need their input " +
  "to proceed — an ambiguous request, a fork in approach, a missing detail. Don't use it " +
  "for things you can decide yourself or find in the workspace. Present 1-4 questions, " +
  'each with 2-4 distinct preset options; a free-form "Other" field is added ' +
  "automatically, so never add your own. Set multiSelect:true when several options can " +
  "apply at once. The turn pauses until the user answers, and their answers are returned " +
  "to you as JSON."

export type NormalizeResult =
  | { ok: true; questions: Question[] }
  | { ok: false; error: string }

// Validate/normalize model-supplied questions. Bounds mirror the published
// schema; we re-check here because a model can ignore the schema — and the MCP
// adapter has no other validation layer in front of it.
export function normalizeQuestions(raw: unknown): NormalizeResult {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "`questions` must be a non-empty array." }
  }
  if (raw.length > MAX_QUESTIONS) {
    return {
      ok: false,
      error: `Ask at most ${MAX_QUESTIONS} questions per call.`,
    }
  }

  const questions: Question[] = []
  for (const q of raw) {
    const item =
      q && typeof q === "object" ? (q as Record<string, unknown>) : {}
    const question = String(item.question ?? "").trim()
    const header = String(item.header ?? "").trim()
    if (!question) {
      return { ok: false, error: "Each question needs `question` text." }
    }
    const opts = Array.isArray(item.options) ? item.options : []
    const options = opts
      .map((o) => {
        const oo =
          o && typeof o === "object" ? (o as Record<string, unknown>) : {}
        const label = String(oo.label ?? "").trim()
        const description = String(oo.description ?? "").trim()
        return label ? { label, ...(description ? { description } : {}) } : null
      })
      .filter((o): o is { label: string; description?: string } => o !== null)
    if (options.length < MIN_OPTIONS) {
      return {
        ok: false,
        error: `Question "${header || question}" needs at least ${MIN_OPTIONS} options.`,
      }
    }
    questions.push({
      question,
      header: header || question.slice(0, 24),
      multiSelect: item.multiSelect === true,
      options: options.slice(0, MAX_OPTIONS),
    })
  }
  return { ok: true, questions }
}

// Pair the answers back with their questions so the model has full context to
// continue. `selected` is the chosen labels; `other` is any free-form text.
export function formatAnswers(
  questions: Question[],
  answers: QuestionAnswer[]
): string {
  return JSON.stringify({
    answers: questions.map((q, i) => ({
      question: q.question,
      header: q.header,
      selected: answers[i]?.selected ?? [],
      other: answers[i]?.other,
    })),
  })
}
