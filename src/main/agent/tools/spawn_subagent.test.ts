import { describe, it, expect, vi } from "vitest"
import { spawnSubagentTool } from "./spawn_subagent"
import type { ToolContext } from "./types"
import { MAX_AGENT_DEPTH } from "../agents/types"

const run = (args: Record<string, unknown>, ctx: Partial<ToolContext>) =>
  spawnSubagentTool.execute(args, ctx as ToolContext)

describe("spawn_subagent guards", () => {
  it("reports unavailable when no spawn callback is wired", async () => {
    const r = await run({ agent_name: "x", prompt: "p" }, {})
    expect(r).toContain("ERROR[unavailable]")
  })

  it("requires agent_name and prompt", async () => {
    const spawnSubagent = vi.fn()
    expect(await run({ prompt: "p" }, { spawnSubagent })).toContain(
      "ERROR[bad_args]"
    )
    expect(await run({ agent_name: "x" }, { spawnSubagent })).toContain(
      "ERROR[bad_args]"
    )
    expect(spawnSubagent).not.toHaveBeenCalled()
  })

  it("rejects at max depth", async () => {
    const spawnSubagent = vi.fn()
    const r = await run(
      { agent_name: "x", prompt: "p" },
      { spawnSubagent, agentChildren: [], agentDepth: MAX_AGENT_DEPTH }
    )
    expect(r).toContain("ERROR[depth_exceeded]")
    expect(spawnSubagent).not.toHaveBeenCalled()
  })

  it("rejects a name already in the ancestor chain (cycle)", async () => {
    const spawnSubagent = vi.fn()
    const r = await run(
      { agent_name: "a", prompt: "p" },
      { spawnSubagent, agentChildren: [], agentAncestors: ["root", "a"] }
    )
    expect(r).toContain("ERROR[cycle_detected]")
    expect(spawnSubagent).not.toHaveBeenCalled()
  })

  it("fails closed when children is undefined (not permitted to spawn)", async () => {
    const spawnSubagent = vi.fn()
    const r = await run(
      { agent_name: "x", prompt: "p" },
      { spawnSubagent, agentChildren: undefined }
    )
    expect(r).toContain("ERROR[no_children]")
    expect(spawnSubagent).not.toHaveBeenCalled()
  })

  it("rejects a name not in a non-empty children whitelist", async () => {
    const spawnSubagent = vi.fn()
    const r = await run(
      { agent_name: "x", prompt: "p" },
      { spawnSubagent, agentChildren: ["a", "b"] }
    )
    expect(r).toContain("ERROR[not_allowed]")
    expect(spawnSubagent).not.toHaveBeenCalled()
  })

  it("empty children whitelist allows any name and returns the child content", async () => {
    const spawnSubagent = vi
      .fn()
      .mockResolvedValue({ content: "the answer" })
    const r = await run(
      { agent_name: "anything", prompt: "do it" },
      { spawnSubagent, agentChildren: [], agentDepth: 0, agentAncestors: [] }
    )
    expect(spawnSubagent).toHaveBeenCalledWith({
      agentName: "anything",
      prompt: "do it",
    })
    expect(r).toBe("the answer")
  })

  it("maps a child error/stopped result to a tool error", async () => {
    const errCtx = {
      spawnSubagent: vi.fn().mockResolvedValue({ error: "boom" }),
      agentChildren: [],
    }
    expect(await run({ agent_name: "x", prompt: "p" }, errCtx)).toContain(
      "ERROR[child_failed]"
    )
    const stopCtx = {
      spawnSubagent: vi.fn().mockResolvedValue({ stopped: true }),
      agentChildren: [],
    }
    expect(await run({ agent_name: "x", prompt: "p" }, stopCtx)).toContain(
      "ERROR[child_stopped]"
    )
  })
})
