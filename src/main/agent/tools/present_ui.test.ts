import { describe, expect, it, vi } from "vitest"
import { presentUiTool } from "./present_ui"
const input = {
  title: "Concept",
  tree: { type: "stack", children: [{ type: "text", text: "Hi" }] },
}
const ctx = (emitArtifact = vi.fn()) => ({
  workspace: "",
  conversationId: "c",
  invocationId: "i",
  emitArtifact,
})
describe("present_ui", () => {
  it("stages validated concepts with explicit revisions", async () => {
    const emitArtifact = vi.fn()
    expect(
      await presentUiTool.execute(
        { ...input, artifactId: "owned", expectedBaseRevision: 1 },
        ctx(emitArtifact)
      )
    ).toContain("awaiting durable")
    expect(emitArtifact).toHaveBeenCalledWith({
      ...input,
      kind: "ui_concept",
      schemaVersion: 1,
      artifactId: "owned",
      expectedBaseRevision: 1,
    })
  })
  it("returns recoverable errors for invalid trees, plan mode and missing runtime", async () => {
    const emitArtifact = vi.fn()
    expect(
      await presentUiTool.execute(
        { title: "x", tree: { type: "script" } },
        ctx(emitArtifact)
      )
    ).toMatch(/bad_args[\s\S]*unsupported node type/)
    expect(
      await presentUiTool.execute(input, {
        ...ctx(emitArtifact),
        planMode: true,
      })
    ).toMatch(/plan mode/)
    expect(await presentUiTool.execute(input, { workspace: "" })).toMatch(
      /durable conversation runtime/
    )
    expect(emitArtifact).not.toHaveBeenCalled()
  })
})
