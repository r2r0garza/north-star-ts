import { expect, it, vi } from "vitest"
import { presentChartTool } from "../tools/present_chart"
import { presentTableTool } from "../tools/present_table"
import { presentUiTool } from "../tools/present_ui"
import { presentVisualTool } from "../tools/present_visual"
import { withToolActivity } from "../../../shared/tool-activity"
import { buildCodexSubscriptionRequest } from "./codex-subscription"
import { validateRequest } from "./claude-subscription/request"
import { createCompletion, type LlmClient } from "./index"

it("preserves artifact schemas and bounded acknowledgements across native transports", async () => {
  const tools = [
    presentChartTool,
    presentTableTool,
    presentUiTool,
    presentVisualTool,
  ].map((tool) => withToolActivity(tool.definition))
  const acknowledgement = JSON.stringify({
    artifactId: "owned-id",
    revision: 2,
    kind: "table",
    title: "Results",
    rowCount: 2,
    status: "saved_for_presentation",
  })
  const messages = [
    { role: "user", content: "Present results" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: {
            name: "present_table",
            arguments: '{"title":"Results","columns":[],"data":[]}',
          },
        },
      ],
    },
    { role: "tool", tool_call_id: "call-1", content: acknowledgement },
  ]
  const body = { messages, tools }
  const codex = buildCodexSubscriptionRequest({
    model: "gpt-5.5",
    maxOutputTokens: 1000,
    body,
  })
  const converted = codex.tools as Array<{ name: string; parameters: unknown }>
  expect(converted.map((tool) => tool.name)).toEqual([
    "present_chart",
    "present_table",
    "present_ui",
    "present_visual",
  ])
  expect(converted[1].parameters).toEqual(tools[1].function.parameters)
  expect(converted[2].parameters).toEqual(tools[2].function.parameters)
  expect(JSON.stringify(codex.input)).toContain("saved_for_presentation")
  const claude = validateRequest({
    model: "claude-sonnet-4-5",
    max_tokens: 1000,
    ...body,
  })
  expect(claude.tools).toHaveLength(4)
  expect(JSON.stringify(claude)).toContain("goTo")
  expect(JSON.stringify(claude)).toContain("expectedBaseRevision")
  expect(JSON.stringify(claude)).toContain("saved_for_presentation")
  const create = vi.fn().mockResolvedValue("ok")
  const client = {
    chat: { completions: { create } },
    models: { list: async () => ({ data: [] }) },
  } as LlmClient
  await createCompletion(client, "artifact-api-test", 1000, body)
  expect(create.mock.calls[0][0].tools).toEqual(tools)
  expect(create.mock.calls[0][0].messages).toEqual(messages)
})
