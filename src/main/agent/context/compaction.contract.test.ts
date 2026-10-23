import { describe, expect, it } from "vitest"
import { translateRequest as anthropicRequest } from "../providers/anthropic"
import { translateRequest as googleRequest } from "../providers/google"
import { buildCodexSubscriptionRequest } from "../providers/codex-subscription"
import {
  clearOldToolResults,
  COMPACTION_PROTECTED_TOOLS,
  compactionTiers,
  continuationMessage,
  latestRound,
} from "./compaction"
import { measureRequest } from "./request-size"

// Plan 118 contract tests: compacted message lists from both tiers, sent
// through each enabled adapter's real request converter.

const model = "test-model"
const big = "x ".repeat(4000)
const tools = ["read_file_tool", "run_tests"].map((name) => ({
  type: "function",
  function: {
    name,
    description: name,
    parameters: { type: "object", properties: { path: { type: "string" } } },
  },
}))

function round(id: string, name = "read_file_tool") {
  return [
    {
      role: "assistant",
      content: "checking",
      tool_calls: [
        {
          id,
          type: "function",
          function: { name, arguments: JSON.stringify({ path: `${id}.ts` }) },
        },
      ],
    },
    { role: "tool", tool_call_id: id, content: big },
  ]
}

const history = [
  { role: "system", content: "system prompt" },
  { role: "user", content: "the objective" },
  ...round("c1"),
  ...round("c2", "run_tests"),
  ...round("c3"),
  ...round("c4"),
  ...round("c5"),
  ...round("c6"),
]

function tier1(): any[] {
  const result = clearOldToolResults(history, {
    total: measureRequest(history).total,
    target: 0,
  })
  expect(result.cleared).toBeGreaterThan(0)
  return result.messages
}

// A rebuild carries the latest round the model has not seen yet.
function tier2(): any[] {
  return [
    { role: "system", content: "system prompt\n\n## Conversation summary" },
    continuationMessage(["the objective"], "## Work ledger"),
    ...latestRound(history),
  ]
}

const tiers = { "tier 1": tier1, "tier 2": tier2 }

describe("compacted requests through the chat-completions shape", () => {
  // Portkey, openai and openai_compatible send the list as-is.
  it.each(Object.entries(tiers))("%s keeps every result paired", (_, build) => {
    const messages = build()
    const calls = new Set<string>()
    for (const m of messages) {
      for (const c of m.tool_calls ?? []) calls.add(c.id)
      if (m.role === "tool") expect(calls.has(m.tool_call_id)).toBe(true)
    }
    expect(messages[1].role).toBe("user")
  })
})

describe("compacted requests through the Codex subscription converter", () => {
  it.each(Object.entries(tiers))(
    "%s has no orphaned outputs and opens with user input",
    (_, build) => {
      const request = buildCodexSubscriptionRequest({
        model,
        maxOutputTokens: 8192,
        body: { messages: build(), tools },
      }) as { input: any[] }
      const calls = new Set<string>()
      for (const item of request.input) {
        if (item.type === "function_call") calls.add(item.call_id)
        if (item.type === "function_call_output")
          expect(calls.has(item.call_id)).toBe(true)
      }
      expect(request.input[0].role).toBe("user")
    }
  )
})

describe("compacted requests through the Anthropic converter", () => {
  it("tier 2 opens with a fresh user turn and keeps the latest round paired", () => {
    const { params } = anthropicRequest({
      model,
      max_tokens: 8192,
      tools,
      messages: tier2(),
    })
    expect(params.messages.map((m: any) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
    ])
    const use = params.messages[1].content.find(
      (b: any) => b.type === "tool_use"
    )
    const result = params.messages[2].content.find(
      (b: any) => b.type === "tool_result"
    )
    expect(result.tool_use_id).toBe(use.id)
  })

  it("tier 1 runs server-side: unchanged history plus a clear_tool_uses edit", () => {
    expect(compactionTiers("anthropic")).toMatchObject({
      clear: false,
      serverClear: true,
    })
    const { params } = anthropicRequest({
      model,
      max_tokens: 8192,
      tools,
      messages: history,
      context_clearing: { trigger: 120_000, clearAtLeast: 60_000 },
    })
    expect(params.betas).toContain("context-management-2025-06-27")
    expect(params.context_management).toEqual({
      edits: [
        {
          type: "clear_tool_uses_20250919",
          trigger: { type: "input_tokens", value: 120_000 },
          clear_at_least: { type: "input_tokens", value: 60_000 },
          keep: { type: "tool_uses", value: 3 },
          exclude_tools: [...COMPACTION_PROTECTED_TOOLS],
        },
      ],
    })
    // Every tool_result answers a tool_use in the assistant turn before it.
    params.messages.forEach((m: any, i: number) => {
      for (const block of Array.isArray(m.content) ? m.content : []) {
        if (block.type !== "tool_result") continue
        const prior = params.messages[i - 1].content.filter(
          (b: any) => b.type === "tool_use"
        )
        expect(prior.map((b: any) => b.id)).toContain(block.tool_use_id)
      }
    })
    expect(params.messages[0].role).toBe("user")
  })

  it("sends no context editing without thresholds", () => {
    const { params } = anthropicRequest({
      model,
      max_tokens: 8192,
      tools,
      messages: history,
    })
    expect(params.context_management).toBeUndefined()
  })
})

describe("compacted requests through the Google converter", () => {
  it("tier 1 stays off for Google", () => {
    expect(compactionTiers("google")).toMatchObject({
      clear: false,
      serverClear: false,
      rebuild: true,
    })
  })

  it("tier 2 opens with user input and keeps the latest round paired", () => {
    const { params } = googleRequest({
      model,
      max_tokens: 8192,
      tools,
      messages: tier2(),
    })
    expect(params.input.map((step: any) => step.type)).toEqual([
      "user_input",
      "model_output",
      "function_call",
      "function_result",
    ])
    expect(params.input[3].call_id).toBe(params.input[2].id)
    expect(params.system_instruction).toContain("Conversation summary")
  })
})
