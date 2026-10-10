import { describe, expect, it } from "vitest"
import { validateRequest } from "./request"

describe("subscription tool metadata boundary", () => {
  it("accepts host MCP effects without sending them to the native inventory", () => {
    const request = validateRequest({
      model: "claude-sonnet-4-6",
      max_tokens: 256,
      messages: [{ role: "user", content: "Hello" }],
      tools: [
        {
          type: "function",
          effects: { readOnly: true, parallelSafe: false, idempotent: true },
          function: {
            name: "mcp_local_lookup",
            description: "Look up a local record",
            parameters: {
              $schema: "http://json-schema.org/draft-07/schema#",
              type: "object",
              properties: { query: { type: ["string", "null"] } },
            },
          },
        },
      ],
    })
    expect(JSON.stringify(request)).not.toContain("effects")
    expect(JSON.stringify(request)).toContain("mcp_local_lookup")
  })
})
