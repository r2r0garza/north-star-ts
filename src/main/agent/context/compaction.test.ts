import { describe, expect, it } from "vitest"
import type { Message, Todo } from "../../db/types"
import {
  buildWorkLedger,
  clearOldToolResults,
  clipToolResults,
  compactionTiers,
  latestRound,
  compactionWatermarks,
  continuationMessage,
  pinnedInstructions,
} from "./compaction"
import { measureRequest } from "./request-size"

const big = "x ".repeat(5000)

function round(id: string, name: string, args: object, result = big) {
  return [
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    { role: "tool", tool_call_id: id, content: result },
  ]
}

function transcript() {
  return [
    { role: "system", content: "system prompt" },
    { role: "user", content: "the objective" },
    ...round("c1", "read_file_tool", { path: "a.ts" }),
    ...round("c2", "read_skill", { name: "tdd" }),
    ...round("c3", "run_tests", { target: "test" }, `FAIL ${big}`),
    ...round("c4", "read_file_tool", { path: "b.ts" }),
    { role: "user", content: "steering: also update docs" },
    ...round("c5", "read_file_tool", { path: "c.ts" }),
    ...round("c6", "read_file_tool", { path: "d.ts" }),
    ...round("c7", "read_file_tool", { path: "e.ts" }),
  ]
}

describe("clearOldToolResults", () => {
  it("clears old results down to the target, keeping pairing and protected messages", () => {
    const messages = transcript()
    const total = measureRequest(messages).total
    const result = clearOldToolResults(messages, { total, target: 0 })

    const byId = new Map(
      result.messages
        .filter((m) => m.role === "tool")
        .map((m) => [m.tool_call_id, m.content as string])
    )
    // Old evidence is stubbed with its tool name and path.
    expect(byId.get("c1")).toMatch(
      /^\[Earlier result cleared to save context: read_file_tool a\.ts, ~[\d.]+k tokens/
    )
    expect(byId.get("c4")).toMatch(/^\[Earlier result cleared/)
    // Instructions and the latest verification result survive.
    expect(byId.get("c2")).toBe(big)
    expect(byId.get("c3")).toBe(`FAIL ${big}`)
    // The last three rounds are kept verbatim.
    for (const id of ["c5", "c6", "c7"]) expect(byId.get(id)).toBe(big)
    // User/system messages and assistant tool calls are untouched.
    expect(result.messages.filter((m) => m.role !== "tool")).toEqual(
      messages.filter((m) => m.role !== "tool")
    )
    expect(result.messages).toHaveLength(messages.length)
    expect(result.cleared).toBe(2)
    expect(result.total).toBeLessThan(total)
  })

  it("stops at the target in one pass and is idempotent", () => {
    const messages = transcript()
    const total = measureRequest(messages).total
    const once = clearOldToolResults(messages, { total, target: total - 100 })
    expect(once.cleared).toBe(1)
    expect(once.total).toBeLessThanOrEqual(total - 100)
    expect(measureRequest(once.messages).total).toBe(once.total)

    const all = clearOldToolResults(messages, { total, target: 0 })
    const again = clearOldToolResults(all.messages, {
      total: all.total,
      target: 0,
    })
    expect(again.cleared).toBe(0)
    expect(again.messages).toEqual(all.messages)
  })

  it("keeps an older verification result only while it is the latest for its target", () => {
    const messages = [
      { role: "user", content: "go" },
      ...round("t1", "run_tests", { target: "test" }, `FAIL ${big}`),
      ...round("t2", "run_tests", { target: "test" }, `PASS ${big}`),
      ...round("r1", "read_file_tool", { path: "a" }),
      ...round("r2", "read_file_tool", { path: "b" }),
      ...round("r3", "read_file_tool", { path: "c" }),
    ]
    const result = clearOldToolResults(messages, {
      total: measureRequest(messages).total,
      target: 0,
    })
    const t = result.messages.filter((m) => m.role === "tool")
    expect(t[0].content).toMatch(/^\[Earlier result cleared/)
    expect(t[1].content).toBe(`PASS ${big}`)
  })

  it("drops replayed images of cleared results", () => {
    const messages = [
      { role: "user", content: "go" },
      ...round("s1", "browser_screenshot", {}),
      {
        role: "user",
        content: [
          { type: "text", text: "source browser_screenshot:s1" },
          { type: "image_url", image_url: { url: "data:image/png;base64,x" } },
        ],
      },
      ...round("r1", "read_file_tool", { path: "a" }),
      ...round("r2", "read_file_tool", { path: "b" }),
      ...round("r3", "read_file_tool", { path: "c" }),
    ]
    const result = clearOldToolResults(messages, {
      total: measureRequest(messages).total,
      target: 0,
    })
    expect(
      result.messages.some(
        (m) =>
          Array.isArray(m.content) &&
          m.content.some((p: any) => p.type === "image_url")
      )
    ).toBe(false)
    expect(measureRequest(result.messages).total).toBe(result.total)
  })
})

function stored(
  seq: number,
  role: Message["role"],
  extra: Partial<Message> = {}
): Message {
  return {
    id: `m${seq}`,
    conversationId: "c",
    seq,
    role,
    content: null,
    toolCalls: null,
    toolCallId: null,
    toolName: null,
    createdAt: seq,
    ...extra,
  } as Message
}

function call(seq: number, id: string, name: string, args: object): Message {
  return stored(seq, "assistant", {
    toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
  })
}

function result(seq: number, id: string, content: string): Message {
  return stored(seq, "tool", { toolCallId: id, content })
}

const todos: Todo[] = [
  ["Fix defect A", "pending"],
  ["Fix defect B", "in_progress"],
  ["Fix defect C", "pending"],
  ["Scaffold", "completed"],
].map(([content, status], i) => ({
  conversationId: "c",
  itemId: String(i),
  seq: i,
  content,
  status: status as Todo["status"],
  createdAt: 0,
  updatedAt: 0,
}))

describe("work ledger and continuation", () => {
  // Plan 118's acceptance fixture: objective, steering, validator findings,
  // three open defects, a failing check and several modified files.
  const turn: Message[] = [
    stored(10, "user", {
      content:
        "The validator rejected the completion. Findings: missing docs\n\nObjective: ship X. Step: implement.",
    }),
    call(11, "w1", "write_file_tool", { path: "src/a.ts", content: "…" }),
    result(12, "w1", "Wrote src/a.ts"),
    call(13, "e1", "edit_file_tool", { path: "src/b.ts" }),
    result(14, "e1", "ERROR[no_match]: old_string not found"),
    call(15, "p1", "apply_patch_tool", {
      operations: [
        { type: "add", path: "src/c.ts" },
        { type: "move", path: "src/d.ts", new_path: "src/e.ts" },
      ],
    }),
    result(16, "p1", "Applied"),
    stored(17, "user", { content: "Note from the user: keep the API stable" }),
    call(18, "t1", "run_tests", { target: "test" }),
    result(19, "t1", "status: passed"),
    call(20, "t2", "run_tests", { target: "test" }),
    result(21, "t2", "status: failed\n1 failing: renders chart"),
  ]

  it("records modified files, the latest check per target, and open todos", () => {
    const ledger = buildWorkLedger(turn, todos)
    expect(ledger).toContain("src/a.ts: written (ok)")
    expect(ledger).toContain("src/b.ts: edited (failed)")
    expect(ledger).toContain("src/c.ts: patched (add) (ok)")
    expect(ledger).toContain("src/d.ts: moved to src/e.ts (ok)")
    expect(ledger).toContain("1 failing: renders chart")
    expect(ledger).not.toContain("status: passed")
    for (const defect of ["Fix defect A", "Fix defect B", "Fix defect C"])
      expect(ledger).toContain(defect)
    expect(ledger).not.toContain("Scaffold")
  })

  it("pins the opening request and every user message of the turn verbatim", () => {
    const opening = [stored(1, "user", { content: "Original step prompt" })]
    const message = continuationMessage(
      pinnedInstructions(turn, opening),
      buildWorkLedger(turn, todos)
    )
    expect(message.role).toBe("user")
    expect(message.content).toContain("Original step prompt")
    expect(message.content).toContain("Findings: missing docs")
    expect(message.content).toContain("Objective: ship X. Step: implement.")
    expect(message.content).toContain("keep the API stable")
    expect(message.content).toContain("Continue from Remaining.")
    // The opening is not duplicated when it is also part of the turn.
    expect(pinnedInstructions(turn, [turn[0]])).toHaveLength(2)
  })
})

describe("compaction gating", () => {
  it("enables tier 1 only where client-side clearing is safe", () => {
    expect(compactionTiers("openai_compatible")).toEqual({
      clear: true,
      serverClear: false,
      rebuild: true,
    })
    expect(compactionTiers("codex_subscription").clear).toBe(true)
    expect(compactionTiers("anthropic")).toEqual({
      clear: false,
      serverClear: true,
      rebuild: true,
    })
    expect(compactionTiers("google")).toEqual({
      clear: false,
      serverClear: false,
      rebuild: true,
    })
    expect(compactionTiers("claude_subscription")).toEqual({
      clear: false,
      serverClear: false,
      rebuild: false,
    })
    expect(compactionTiers("claude_code").rebuild).toBe(false)
  })

  it("derives watermarks from the setting and the known window", () => {
    expect(compactionWatermarks(0, 200_000)).toBeNull()
    expect(compactionWatermarks(120_000, null)).toEqual({
      high: 120_000,
      low: 60_000,
    })
    expect(compactionWatermarks(120_000, 100_000)).toEqual({
      high: 80_000,
      low: 40_000,
    })
  })
})

describe("latest round", () => {
  it("returns the last tool call and its results, or nothing after a text answer", () => {
    const messages = transcript()
    const round = latestRound(messages)
    expect(round.map((m) => m.role)).toEqual(["assistant", "tool"])
    expect(round[1].tool_call_id).toBe("c7")
    expect(
      latestRound([...messages, { role: "assistant", content: "done" }])
    ).toEqual([])
    expect(latestRound([{ role: "user", content: "go" }])).toEqual([])
  })

  it("clips every result proportionally to fit the budget", () => {
    const round = [
      ...round2("p1", big),
      { role: "tool", tool_call_id: "p2", content: `${big}${big}` },
    ]
    const clipped = clipToolResults(round, 2000)
    const tools = clipped.filter((m) => m.role === "tool")
    expect(measureRequest(tools).total).toBeLessThanOrEqual(2000 + 200)
    for (const m of tools) {
      expect(m.content).toMatch(/Truncated to fit the context budget/)
      expect(m.content.length).toBeGreaterThan(200)
    }
    expect(clipped[0]).toBe(round[0])
    // Within budget: unchanged.
    expect(clipToolResults(round, 1_000_000)).toEqual(round)
  })
})

function round2(id: string, result: string) {
  return round(id, "read_file_tool", { path: id }, result)
}
