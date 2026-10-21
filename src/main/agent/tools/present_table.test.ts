import { describe, expect, it, vi } from "vitest"
import { presentTableTool } from "./present_table"
const input = {
  title: "Results",
  columns: [{ key: "value", label: "Value", valueType: "number" }],
  data: [{ value: null }, { value: 0 }],
}
describe("present_table", () => {
  it("stages validated snapshots and explicit revisions without fetching data", async () => {
    const emitArtifact = vi.fn()
    const result = await presentTableTool.execute(
      { ...input, artifactId: "owned-id", expectedBaseRevision: 2 },
      { workspace: "", conversationId: "c", invocationId: "i", emitArtifact }
    )
    expect(result).toContain("awaiting durable")
    expect(emitArtifact).toHaveBeenCalledWith({
      ...input,
      kind: "table",
      schemaVersion: 1,
      artifactId: "owned-id",
      expectedBaseRevision: 2,
    })
  })
  it("excludes display-only activity metadata while keeping snapshot validation strict", async () => {
    const emitArtifact = vi.fn()
    const ctx = {
      workspace: "",
      conversationId: "c",
      invocationId: "i",
      emitArtifact,
    }
    const args = { ...input, _activity: "Presenting observed results" }
    expect(await presentTableTool.execute(args, ctx)).toContain(
      "awaiting durable"
    )
    expect(emitArtifact).toHaveBeenCalledWith({
      ...input,
      kind: "table",
      schemaVersion: 1,
    })
    expect(args._activity).toBe("Presenting observed results")
    emitArtifact.mockClear()
    expect(
      await presentTableTool.execute({ ...args, unexpected: true }, ctx)
    ).toContain("ERROR[bad_args]")
    expect(emitArtifact).not.toHaveBeenCalled()
  })
  it("fails closed for unavailable, plan, cancelled and invalid calls", async () => {
    const emitArtifact = vi.fn()
    const ctx = {
      workspace: "",
      conversationId: "c",
      invocationId: "i",
      emitArtifact,
    }
    expect(await presentTableTool.execute(input, { workspace: "" })).toContain(
      "ERROR[unavailable]"
    )
    expect(
      await presentTableTool.execute(input, { ...ctx, planMode: true })
    ).toContain("ERROR[unavailable]")
    expect(
      await presentTableTool.execute(input, {
        ...ctx,
        signal: AbortSignal.abort(),
      })
    ).toContain("ERROR[cancelled]")
    expect(
      await presentTableTool.execute({ ...input, data: [{}] }, ctx)
    ).toContain("ERROR[bad_args]")
    expect(emitArtifact).not.toHaveBeenCalled()
  })
})
