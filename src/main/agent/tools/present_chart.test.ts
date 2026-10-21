import { describe, expect, it, vi } from "vitest"
import { presentChartTool } from "./present_chart"
import { TOOL_EFFECTS } from "./types"

const input = {
  title: "Results",
  chartKind: "bar",
  xKey: "category",
  series: [{ key: "value", label: "Value" }],
  data: [{ category: "A", value: 1 }],
}
describe("present_chart", () => {
  it("fails closed outside a durable runtime, in plan mode and after cancellation", async () => {
    const emitArtifact = vi.fn()
    expect(await presentChartTool.execute(input, { workspace: "" })).toContain(
      "ERROR[unavailable]"
    )
    const ctx = {
      workspace: "",
      conversationId: "conversation",
      invocationId: "invocation",
      emitArtifact,
    }
    expect(
      await presentChartTool.execute(input, { ...ctx, planMode: true })
    ).toContain("ERROR[unavailable]")
    expect(
      await presentChartTool.execute(input, {
        ...ctx,
        signal: AbortSignal.abort(),
      })
    ).toContain("ERROR[cancelled]")
    expect(emitArtifact).not.toHaveBeenCalled()
  })
  it("excludes display-only activity metadata while keeping snapshot validation strict", async () => {
    const emitArtifact = vi.fn()
    const ctx = {
      workspace: "",
      conversationId: "conversation",
      invocationId: "invocation",
      emitArtifact,
    }
    const args = { ...input, _activity: "Presenting observed results" }
    expect(await presentChartTool.execute(args, ctx)).toContain(
      "awaiting durable"
    )
    expect(emitArtifact).toHaveBeenCalledWith({
      ...input,
      kind: "chart",
      schemaVersion: 1,
    })
    expect(args._activity).toBe("Presenting observed results")
    emitArtifact.mockClear()
    expect(
      await presentChartTool.execute({ ...args, unexpected: true }, ctx)
    ).toContain("ERROR[bad_args]")
    expect(emitArtifact).not.toHaveBeenCalled()
  })
  it("stages validated snapshot without claiming a durable save or fetching data", async () => {
    const emitArtifact = vi.fn()
    const ctx = {
      workspace: "",
      conversationId: "conversation",
      invocationId: "invocation",
      emitArtifact,
    }
    expect(await presentChartTool.execute(input, ctx)).toContain(
      "awaiting durable"
    )
    expect(emitArtifact).toHaveBeenCalledWith({
      ...input,
      kind: "chart",
      schemaVersion: 1,
    })
    emitArtifact.mockClear()
    expect(
      await presentChartTool.execute(
        { ...input, recipe: { url: "https://example.com" } },
        ctx
      )
    ).toContain("ERROR[bad_args]")
    expect(emitArtifact).not.toHaveBeenCalled()
    expect(presentChartTool.effects).toEqual(TOOL_EFFECTS.mutation)
  })
})
