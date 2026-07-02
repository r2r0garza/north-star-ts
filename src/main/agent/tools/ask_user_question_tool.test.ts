import { describe, it, expect, vi } from "vitest"
import { askUserQuestionTool } from "./ask_user_question_tool"
import type { ToolContext } from "./types"
import type { AskResult, Question } from "./types"

// A valid single question to reuse.
const validQuestion = {
  question: "Which database should we use?",
  header: "Database",
  options: [
    { label: "Postgres" },
    { label: "SQLite", description: "embedded" },
  ],
}

// Build a ctx whose `ask` resolves with the given result and records what it saw.
function ctxWith(result: AskResult) {
  const ask = vi
    .fn<(q: Question[]) => Promise<AskResult>>()
    .mockResolvedValue(result)
  const ctx: ToolContext = { workspace: "", ask }
  return { ctx, ask }
}

describe("ask_user_question", () => {
  it("reports unavailable when ctx has no ask (e.g. headless)", async () => {
    const result = await askUserQuestionTool.execute(
      { questions: [validQuestion] },
      { workspace: "" }
    )
    expect(result).toContain("ERROR[unavailable]")
  })

  it("rejects an empty questions array", async () => {
    const { ctx } = ctxWith({ status: "answered", answers: [] })
    const result = await askUserQuestionTool.execute({ questions: [] }, ctx)
    expect(result).toContain("ERROR[bad_args]")
  })

  it("rejects more than 4 questions", async () => {
    const { ctx, ask } = ctxWith({ status: "answered", answers: [] })
    const many = Array.from({ length: 5 }, () => validQuestion)
    const result = await askUserQuestionTool.execute({ questions: many }, ctx)
    expect(result).toContain("ERROR[bad_args]")
    expect(ask).not.toHaveBeenCalled()
  })

  it("rejects a question with fewer than 2 options", async () => {
    const { ctx } = ctxWith({ status: "answered", answers: [] })
    const result = await askUserQuestionTool.execute(
      {
        questions: [
          { question: "Pick", header: "x", options: [{ label: "only" }] },
        ],
      },
      ctx
    )
    expect(result).toContain("ERROR[bad_args]")
  })

  it("passes normalized questions to ask and returns the answers", async () => {
    const { ctx, ask } = ctxWith({
      status: "answered",
      answers: [{ selected: ["Postgres"] }],
    })
    const result = await askUserQuestionTool.execute(
      { questions: [validQuestion] },
      ctx
    )

    // ask saw a clean Question with multiSelect defaulted to false.
    expect(ask).toHaveBeenCalledOnce()
    const passed = ask.mock.calls[0][0]
    expect(passed[0]).toMatchObject({
      question: "Which database should we use?",
      header: "Database",
      multiSelect: false,
    })
    expect(passed[0].options).toHaveLength(2)

    const parsed = JSON.parse(result)
    expect(parsed.answers[0]).toMatchObject({
      question: "Which database should we use?",
      selected: ["Postgres"],
    })
  })

  it("includes free-form Other text in the returned answer", async () => {
    const { ctx } = ctxWith({
      status: "answered",
      answers: [{ selected: [], other: "Use DynamoDB" }],
    })
    const result = await askUserQuestionTool.execute(
      { questions: [validQuestion] },
      ctx
    )
    expect(JSON.parse(result).answers[0].other).toBe("Use DynamoDB")
  })

  it("drops blank options and synthesizes a header when omitted", async () => {
    const { ctx, ask } = ctxWith({
      status: "answered",
      answers: [{ selected: ["A"] }],
    })
    await askUserQuestionTool.execute(
      {
        questions: [
          {
            question: "A long question with no explicit header provided here",
            options: [{ label: "A" }, { label: "  " }, { label: "B" }],
          },
        ],
      },
      ctx
    )
    const passed = ask.mock.calls[0][0][0]
    expect(passed.options).toHaveLength(2) // blank dropped
    expect(passed.header).toBeTruthy() // synthesized from question
  })

  it("returns a cancelled error when the user dismisses (turn stopped)", async () => {
    const { ctx } = ctxWith({ status: "cancelled" })
    const result = await askUserQuestionTool.execute(
      { questions: [validQuestion] },
      ctx
    )
    expect(result).toContain("ERROR[cancelled]")
  })
})
