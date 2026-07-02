import { useState } from "react"
import { Check, ChevronLeft, ChevronRight, CircleHelp } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { Question, QuestionAnswer } from "@/types"

// The free-form "Other" choice is always appended by the UI (the model never
// specifies it). Matched by reference via this constant, not the string.
const OTHER = "__other__"

// A clarifying-questions prompt the agent raised (ask_user_question). Shows ONE
// question at a time: the question headers run across the top as tabs (click to
// jump, with a check on answered ones), Back/Next page between them, and Submit
// — enabled only once every question is answered — sends all answers at once.
// Lives above the composer (App.tsx) so it stays put while the transcript scrolls.
export function QuestionPanel({
  questions,
  onSubmit,
}: {
  questions: Question[]
  onSubmit: (answers: QuestionAnswer[]) => void
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
    const sel = selected[qi]
    if (sel.length === 0) return false
    if (sel.includes(OTHER) && !otherText[qi].trim()) return false
    return true
  }
  const allAnswered = questions.every((_, qi) => answered(qi))

  function submit() {
    if (!allAnswered) return
    const answers: QuestionAnswer[] = questions.map((_, qi) => {
      const sel = selected[qi]
      const labels = sel.filter((s) => s !== OTHER)
      const other = sel.includes(OTHER) ? otherText[qi].trim() : undefined
      return { selected: labels, ...(other ? { other } : {}) }
    })
    onSubmit(answers)
  }

  const q = questions[current]
  const sel = selected[current]
  const otherSelected = sel.includes(OTHER)
  const multi = q.multiSelect === true
  const isFirst = current === 0
  const isLast = current === questions.length - 1
  const multiple = questions.length > 1

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4 text-sm">
      <div className="flex items-center gap-2 font-medium text-foreground">
        <CircleHelp className="size-4 shrink-0 text-primary" />
        <span>{multiple ? "A few questions" : "A quick question"}</span>
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
        <span className="font-medium">{q.question}</span>
        <div className="flex flex-col gap-1.5">
          {q.options.map((opt) => {
            const on = sel.includes(opt.label)
            return (
              <button
                key={opt.label}
                type="button"
                onClick={() => toggle(current, opt.label, multi)}
                className={cn(
                  "flex items-start gap-2 rounded-md border px-3 py-2 text-left transition-colors",
                  on
                    ? "border-primary bg-primary/5"
                    : "border-input hover:bg-accent"
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
          {/* Always-present free-form "Other" choice. */}
          <button
            type="button"
            onClick={() => toggle(current, OTHER, multi)}
            className={cn(
              "flex items-center gap-2 rounded-md border px-3 py-2 text-left transition-colors",
              otherSelected
                ? "border-primary bg-primary/5"
                : "border-input hover:bg-accent"
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
            <span className="font-medium">Other…</span>
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
              rows={2}
              placeholder="Type your answer…"
              className="field-sizing-content w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          )}
        </div>
      </div>

      {/* Footer: Back / Next page between questions; Submit sends everything. */}
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
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
