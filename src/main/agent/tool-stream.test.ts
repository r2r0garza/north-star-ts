import { describe, it, expect } from "vitest"
import { accumulateToolCalls, type ToolCallDelta } from "./tool-stream"

describe("accumulateToolCalls", () => {
  it("separates parallel calls by numeric index (standard OpenAI stream)", () => {
    const fragments: ToolCallDelta[] = [
      { index: 0, id: "call_a", function: { name: "read_file_tool", arguments: '{"path":"a' } },
      { index: 1, id: "call_b", function: { name: "read_file_tool", arguments: '{"path":"b' } },
      { index: 0, function: { arguments: '.md"}' } },
      { index: 1, function: { arguments: '.md"}' } },
    ]
    expect(accumulateToolCalls(fragments)).toEqual([
      { id: "call_a", name: "read_file_tool", arguments: '{"path":"a.md"}' },
      { id: "call_b", name: "read_file_tool", arguments: '{"path":"b.md"}' },
    ])
  })

  it("separates parallel calls when the provider omits index (Copilot bridge)", () => {
    const fragments: ToolCallDelta[] = [
      { id: "call_a", function: { name: "read_file_tool", arguments: '{"path":"a' } },
      { function: { arguments: '.md"}' } },
      { id: "call_b", function: { name: "read_file_tool", arguments: '{"path":"b.md"}' } },
    ]
    expect(accumulateToolCalls(fragments)).toEqual([
      { id: "call_a", name: "read_file_tool", arguments: '{"path":"a.md"}' },
      { id: "call_b", name: "read_file_tool", arguments: '{"path":"b.md"}' },
    ])
  })

  it("separates calls that all report index 0 but carry distinct ids", () => {
    const fragments: ToolCallDelta[] = [
      { index: 0, id: "call_a", function: { name: "read_file_tool", arguments: '{"path":"a.md"}' } },
      { index: 0, id: "call_b", function: { name: "read_file_tool", arguments: '{"path":"b.md"}' } },
    ]
    expect(accumulateToolCalls(fragments)).toEqual([
      { id: "call_a", name: "read_file_tool", arguments: '{"path":"a.md"}' },
      { id: "call_b", name: "read_file_tool", arguments: '{"path":"b.md"}' },
    ])
  })

  it("assembles a single call split across fragments", () => {
    const fragments: ToolCallDelta[] = [
      { id: "call_a", function: { name: "read_file_tool", arguments: "" } },
      { function: { arguments: '{"path"' } },
      { function: { arguments: ':"only.md"}' } },
    ]
    expect(accumulateToolCalls(fragments)).toEqual([
      { id: "call_a", name: "read_file_tool", arguments: '{"path":"only.md"}' },
    ])
  })

  it("returns an empty array when no fragments arrive", () => {
    expect(accumulateToolCalls([])).toEqual([])
  })
})
