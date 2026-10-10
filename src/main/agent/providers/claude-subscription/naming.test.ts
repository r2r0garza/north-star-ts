import { describe, expect, it } from "vitest"
import { nativeToolName } from "./history"
import { startInventory } from "./mcp"
import { validateRequest } from "./request"

const external = "mcp__ado__testplan_show_test_results_from_build_id"
const definition = (name: string) => ({
  type: "function",
  function: {
    name,
    description: "Test inventory",
    parameters: { type: "object" },
  },
})
const body = {
  model: "claude-sonnet-4-6",
  max_tokens: 256,
  messages: [{ role: "user", content: "Current question" }],
  tools: [definition("read_file"), definition(external)],
}

describe("per-server inert inventory naming", () => {
  it("preserves external identities and uses a short built-in namespace", () => {
    const request = validateRequest(body)
    expect(nativeToolName(external)).toBe(external)
    expect(nativeToolName("read_file")).toBe("mcp__ns__read_file")
    expect(request.names.get(external)).toBe(external)
    expect(request.names.get("mcp__ns__read_file")).toBe("read_file")
    expect((request.extraBody.tools as any[]).map((tool) => tool.name)).toEqual(
      ["mcp__ns__read_file", external]
    )
  })

  it("replays canonical external calls and removed tools without authorizing them", () => {
    const removed = "mcp__other-server__removed_tool"
    const request = validateRequest({
      ...body,
      messages: [
        { role: "user", content: "Past question" },
        {
          role: "assistant",
          content: null,
          tool_calls: [external, removed].map((name, index) => ({
            id: `past_${index}`,
            type: "function",
            function: { name, arguments: "{}" },
          })),
        },
        {
          role: "tool",
          tool_call_id: "past_0",
          content: "Past external result",
        },
        {
          role: "tool",
          tool_call_id: "past_1",
          content: "Past removed result",
        },
        ...body.messages,
      ],
    })
    expect(
      request.frames[1].message.content.map((block) => block.name)
    ).toEqual([external, removed])
    expect(
      request.frames[2].message.content.map((block) => block.tool_use_id)
    ).toEqual(["past_0", "past_1", undefined])
    expect(request.names.has(removed)).toBe(false)
  })

  it("rejects normalization, collisions and truly overlong native names explicitly", () => {
    for (const name of [
      "mcp__ADO__lookup",
      "mcp__a_b__lookup",
      "mcp__ado__",
      "mcp__ado__" + "x".repeat(55),
    ])
      expect(() => nativeToolName(name)).toThrow()
    expect(nativeToolName("mcp__ado__" + "x".repeat(54))).toHaveLength(64)
    expect(() =>
      validateRequest({
        ...body,
        tools: [definition("read_file"), definition("mcp__ns__read_file")],
      })
    ).toThrow()
    expect(() =>
      validateRequest({
        ...body,
        messages: [
          { role: "user", content: "Past" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "past",
                type: "function",
                function: { name: "mcp__ns__read_file", arguments: "{}" },
              },
            ],
          },
          { role: "tool", tool_call_id: "past", content: "Past result" },
        ],
      })
    ).toThrow(/collision/)
  })

  it("shares a listener while exposing only each server's original tool names and denying all execution", async () => {
    const inventory = await startInventory(validateRequest(body).tools)
    try {
      expect(Object.keys(inventory.config.mcpServers)).toEqual(["ns", "ado"])
      const urls = Object.values(inventory.config.mcpServers).map(
        (server) => new URL(server.url)
      )
      expect(urls[0].origin).toBe(urls[1].origin)
      for (const [server, config] of Object.entries(
        inventory.config.mcpServers
      )) {
        const rpc = async (method: string, params: object) => {
          const response = await fetch(config.url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          })
          return (await response.json()) as any
        }
        const original =
          server === "ns"
            ? "read_file"
            : "testplan_show_test_results_from_build_id"
        expect(
          (await rpc("tools/list", {})).result.tools.map(
            (tool: any) => tool.name
          )
        ).toEqual([original])
        for (const name of [original, "fabricated"])
          expect(
            (await rpc("tools/call", { name, arguments: {} })).result.isError
          ).toBe(true)
      }
    } finally {
      await inventory.close()
    }
  })
})
