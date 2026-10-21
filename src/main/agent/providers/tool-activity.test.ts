import { expect, it } from "vitest"
import { withToolActivity } from "../../../shared/tool-activity"
import { buildCodexSubscriptionRequest } from "./codex-subscription"
import { validateRequest } from "./claude-subscription/request"

it("preserves optional activity fields through Codex and Claude request conversion", () => {
  const tool = withToolActivity({
    type: "function" as const,
    function: {
      name: "inspect_prompt",
      description: "Inspect a prompt",
      parameters: { type: "object", properties: {}, required: [] },
    },
  })
  const codex = buildCodexSubscriptionRequest({
    model: "gpt-5.5",
    maxOutputTokens: 1000,
    body: {
      messages: [{ role: "user", content: "inspect" }],
      tools: [tool],
    },
  })
  const tools = codex.tools as Array<{ parameters: Record<string, unknown> }>
  expect(tools[0].parameters.properties).toHaveProperty("_activity")
  expect(tools[0].parameters.required).toEqual([])
  expect(() =>
    validateRequest({
      model: "claude-sonnet-4-5",
      max_tokens: 1000,
      messages: [{ role: "user", content: "inspect" }],
      tools: [tool],
    })
  ).not.toThrow()
})
