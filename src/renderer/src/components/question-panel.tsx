import { useEffect, useRef, useState } from "react"
import { Check, ChevronLeft, ChevronRight, CircleHelp } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Markdown } from "@/components/markdown"
import { cn } from "@/lib/utils"
import type { Question, QuestionAnswer } from "@/types"

// The free-form "Other" choice is always appended by the UI (the model never
// specifies it). Matched by reference via this constant, not the string.
const OTHER = "__other__"

// True when a keystroke is landing in an editable field, so the panel's global
// single-key navigation stands down (the Other textarea keeps its own keys). A
// local copy of App.tsx's guard on purpose — it's tiny and the repo already
// keeps per-file copies (see the note at App.tsx's isTypingTarget).
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  )
}

// Pure, snapshot-based helpers so the Enter path can decide advance-vs-submit and
// build the final answers from a JUST-computed selection synchronously (setState
// is async, so reading component state right after a set would be stale).
function isAnswered(sel: string[], other: string): boolean {
  if (sel.length === 0) return false
  if (sel.includes(OTHER) && !other.trim()) return false
  return true
}
function isAllAnswered(
  questions: Question[],
  selected: string[][],
  otherText: string[]
): boolean {
  return questions.every((_, qi) => isAnswered(selected[qi], otherText[qi]))
}
function buildAnswers(
  questions: Question[],
  selected: string[][],
  otherText: string[]
): QuestionAnswer[] {
  return questions.map((_, qi) => {
    const sel = selected[qi]
    const labels = sel.filter((s) => s !== OTHER)
    const other = sel.includes(OTHER) ? otherText[qi].trim() : undefined
    return { selected: labels, ...(other ? { other } : {}) }
  })
}

// A clarifying-questions prompt the agent raised (ask_user_question). Shows ONE
// question at a time: the question headers run across the top as tabs (click to
// jump, with a check on answered ones), Back/Next page between them, and Submit
// — enabled only once every question is answered — sends all answers at once.
// Lives above the composer (App.tsx) so it stays put while the transcript scrolls.
//
// Keyboard: Up/Down move the highlighted ("active") option (the presets plus the
// Other pseudo-option, wrapping); Left/Right page between questions (when 2+);
// Enter selects the active option. On a single-select question Enter selects then
// moves forward (advances, or submits on the last question); on a multi-select
// question Enter only toggles and stays put — the user advances with Next/Right
// and submits with the Submit button. Driven by a WINDOW listener (the panel's
// buttons aren't focused), so App blurs the composer while this is open.
export function QuestionPanel({
  questions,
  onSubmit,
  onCancel,
}: {
  questions: Question[]
  onSubmit: (answers: QuestionAnswer[]) => void
  // Back out of the question entirely (stops the turn). When omitted, no Cancel
  // is shown. Used e.g. for the plan approval, where the user may decide not to
  // proceed with the plan at all rather than approve or keep refining.
  onCancel?: () => void
}) {
  // Per-question selected option labels (OTHER is a member when chosen) and the
  // free-form text typed for Other. Indexed parallel to `questions`.
  const [selected, setSelected] = useState<string[][]>(() =>
    questions.map(() => [])
  )
  const [otherText, setOtherText] = useState<string[]>(() =>
    questions.map(() => "")
  )
  // Which question is currently shown.
  const [current, setCurrent] = useState(0)
  // The keyboard-highlighted option, as an index into the navigable list
  // (presets + Other). Distinct from selection: this is just where the arrows
  // are pointing. Re-seeded when the question changes (see effect below).
  const [activeIdx, setActiveIdx] = useState(0)

  function toggle(qi: number, value: string, multi: boolean) {
    setSelected((prev) => {
      const next = prev.map((s) => [...s])
      const cur = next[qi]
      if (multi) {
        const at = cur.indexOf(value)
        if (at >= 0) cur.splice(at, 1)
        else cur.push(value)
      } else {
        next[qi] = cur.includes(value) ? [] : [value]
      }
      return next
    })
  }

  // A question is answered when it has at least one selection, and if "Other"
  // is selected, the free-form text is non-empty.
  function answered(qi: number): boolean {
    return isAnswered(selected[qi], otherText[qi])
  }
  const allAnswered = isAllAnswered(questions, selected, otherText)

  function submit() {
    if (!allAnswered) return
    onSubmit(buildAnswers(questions, selected, otherText))
  }
  // Submit from an explicit snapshot — used by the single-select Enter path,
  // which has just computed a new selection that component state doesn't reflect
  // yet.
  function submitSnapshot(sel: string[][], other: string[]) {
    if (!isAllAnswered(questions, sel, other)) return
    onSubmit(buildAnswers(questions, sel, other))
  }

  const q = questions[current]
  const sel = selected[current]
  const otherSelected = sel.includes(OTHER)
  const multi = q.multiSelect === true
  const isFirst = current === 0
  const isLast = current === questions.length - 1
  const multiple = questions.length > 1

  // The navigable list for the current question: the preset options followed by
  // the Other pseudo-option (always the last item). activeIdx points into this.
  const optionValues = [...q.options.map((o) => o.label), OTHER]
  const OTHER_IDX = q.options.length
  // Clamp on read so a question with fewer options than the previous one can't
  // leave the index dangling past the end.
  const safeActive = Math.min(activeIdx, optionValues.length - 1)

  // Re-seed the active option when the question changes: to the currently
  // selected option if there is one, else the first. Keyed on `current` only so
  // toggling within a question doesn't fight the user's arrow position.
  useEffect(() => {
    const s = selected[current]
    const firstSelected = optionValues.findIndex((v) => s.includes(v))
    setActiveIdx(firstSelected >= 0 ? firstSelected : 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current])

  // Enter behavior. Single-select: select the active option and move forward
  // (advance, or submit on the last question). Multi-select: only toggle the
  // active option and stay — never advance, never submit. Selecting Other in a
  // single-select question reveals its textarea (autoFocus) without advancing,
  // since the user must type before the answer counts.
  function onEnter() {
    const activeValue = optionValues[safeActive]
    const isOther = activeValue === OTHER

    if (multi) {
      toggle(current, activeValue, true)
      return
    }

    if (isOther) {
      setSelected((prev) => {
        const next = prev.map((s) => [...s])
        next[current] = [OTHER]
        return next
      })
      return
    }

    // Single-select preset: build the new selection locally so the advance-vs-
    // submit decision reads the fresh choice, not stale state.
    const nextSelected = selected.map((s) => [...s])
    nextSelected[current] = [activeValue]
    setSelected(nextSelected)
    if (isLast) submitSnapshot(nextSelected, otherText)
    else setCurrent((c) => Math.min(questions.length - 1, c + 1))
  }

  // Ref-to-latest handler so the window listener (attached once) always sees
  // fresh state instead of a stale closure (mirrors task-completion-toasts).
  const handlerRef = useRef<(e: KeyboardEvent) => void>(() => {})
  handlerRef.current = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.repeat) return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    // The Other textarea (or any field) owns its own keys — stand down.
    if (isTypingTarget(e.target)) return

    const len = optionValues.length
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActiveIdx((i) => (Math.min(i, len - 1) + 1) % len)
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActiveIdx((i) => (Math.min(i, len - 1) - 1 + len) % len)
    } else if (e.key === "ArrowRight" && multiple) {
      e.preventDefault()
      setCurrent((c) => Math.min(questions.length - 1, c + 1))
    } else if (e.key === "ArrowLeft" && multiple) {
      e.preventDefault()
      setCurrent((c) => Math.max(0, c - 1))
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      onEnter()
    }
  }

  useEffect(() => {
    const listener = (e: KeyboardEvent) => handlerRef.current(e)
    window.addEventListener("keydown", listener)
    return () => window.removeEventListener("keydown", listener)
  }, [])

  // When any question carries a body (e.g. plan approval), the panel title and
  // question-text rendering change to match the plan-review context.
  const isPlanReview = questions.some((q) => q.body)

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4 text-sm">
      <div className="flex items-center gap-2 font-medium text-foreground">
        <CircleHelp className="size-4 shrink-0 text-primary" />
        <span>
          {isPlanReview
            ? "Approve or keep working on the plan"
            : multiple
              ? "A few questions"
              : "A quick question"}
        </span>
      </div>

      {/* Header tabs — one per question; click to jump. A check marks answered
          questions; the current one is highlighted. Only shown for 2+. */}
      {multiple && (
        <div className="flex flex-wrap gap-1.5">
          {questions.map((qq, qi) => (
            <button
              key={qi}
              type="button"
              onClick={() => setCurrent(qi)}
              className={cn(
                "flex items-center gap-1 rounded-md px-2 py-1 text-[0.7rem] font-medium transition-colors",
                qi === current
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-accent"
              )}
            >
              {answered(qi) && <Check className="size-3 shrink-0" />}
              {qq.header}
            </button>
          ))}
        </div>
      )}

      {/* Current question + its options. */}
      <div className="flex flex-col gap-2">
        {/* Skip the question text when a body is present (plan approval) — the
            body + panel title already provide full context. */}
        {q.question && !q.body && (
          <span className="font-medium">{q.question}</span>
        )}
        {/* Optional Markdown context (e.g. the plan being approved), capped in
            height and scrolled internally so a long body never dominates. */}
        {q.body && (
          <div className="max-h-[40vh] overflow-y-auto rounded-md border bg-muted/30 px-3 py-2">
            <Markdown content={q.body} />
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          {q.options.map((opt, optIndex) => {
            const on = sel.includes(opt.label)
            const active = optIndex === safeActive
            return (
              <button
                key={opt.label}
                type="button"
                onClick={() => toggle(current, opt.label, multi)}
                onMouseEnter={() => setActiveIdx(optIndex)}
                className={cn(
                  "flex items-start gap-2 rounded-md border px-3 py-2 text-left transition-colors",
                  on
                    ? "border-primary bg-primary/5"
                    : "border-input hover:bg-accent",
                  active && "ring-2 ring-ring ring-offset-1"
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                    on
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-input"
                  )}
                >
                  {on && <Check className="size-3" />}
                </span>
                <span className="flex flex-col">
                  <span className="font-medium">{opt.label}</span>
                  {opt.description && (
                    <span className="text-xs text-muted-foreground">
                      {opt.description}
                    </span>
                  )}
                </span>
              </button>
            )
          })}
          {/* Free-form choice — label customisable per question (e.g. "Refine Plan…"). */}
          <button
            type="button"
            onClick={() => toggle(current, OTHER, multi)}
            onMouseEnter={() => setActiveIdx(OTHER_IDX)}
            className={cn(
              "flex items-center gap-2 rounded-md border px-3 py-2 text-left transition-colors",
              otherSelected
                ? "border-primary bg-primary/5"
                : "border-input hover:bg-accent",
              safeActive === OTHER_IDX && "ring-2 ring-ring ring-offset-1"
            )}
          >
            <span
              className={cn(
                "flex size-4 shrink-0 items-center justify-center rounded-full border",
                otherSelected
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-input"
              )}
            >
              {otherSelected && <Check className="size-3" />}
            </span>
            <span className="font-medium">{q.otherLabel ?? "Other…"}</span>
          </button>
          {otherSelected && (
            <textarea
              autoFocus
              value={otherText[current]}
              onChange={(e) =>
                setOtherText((prev) => {
                  const next = [...prev]
                  next[current] = e.target.value
                  return next
                })
              }
              onKeyDown={(e) => {
                // In a multi-select question Enter must never advance/submit, so
                // let it insert a newline (default). In single-select, plain Enter
                // advances to the next question or submits, mirroring the composer;
                // Shift+Enter always inserts a newline.
                if (e.key === "Enter" && !e.shiftKey) {
                  if (multi) return
                  e.preventDefault()
                  if (isLast) submit()
                  else if (answered(current))
                    setCurrent((c) => Math.min(questions.length - 1, c + 1))
                }
              }}
              rows={2}
              placeholder={q.otherLabel ?? "Type your answer…"}
              className="field-sizing-content w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          )}
        </div>
      </div>

      {/* Footer: Cancel backs out entirely; Back / Next page between questions;
          Submit sends everything. */}
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          {onCancel && (
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
          {multiple && (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setCurrent((c) => Math.max(0, c - 1))}
                disabled={isFirst}
              >
                <ChevronLeft className="size-4" /> Back
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setCurrent((c) => Math.min(questions.length - 1, c + 1))
                }
                disabled={isLast}
              >
                Next <ChevronRight className="size-4" />
              </Button>
            </>
          )}
        </div>
        <Button size="sm" onClick={submit} disabled={!allAnswered}>
          Submit
        </Button>
      </div>
    </div>
  )
}
