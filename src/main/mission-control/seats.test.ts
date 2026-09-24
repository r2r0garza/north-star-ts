import { describe, expect, it } from "vitest"
import type { AgentDefinition } from "../agent/agents/types"
import type { RigPod, RigSeat } from "../db/types"
import { resolveSeat } from "./seats"

const pod: RigPod = {
  id: "pod",
  rigId: "rig",
  key: "implementation",
  name: "Implementation",
  missionStatement: "",
  cultureMd: "",
  leadSeatId: null,
  position: 0,
}

const seat: RigSeat = {
  id: "seat",
  podId: "pod",
  key: "builder",
  role: "builder",
  charter: "Build it",
  agentRefId: "ref",
  agentLabel: "Builder snapshot",
  skills: [],
  tools: null,
  mcpServers: ["docs"],
  decisionRights: [],
  runtimeConfig: { worker: { accountId: "seat-account", modelId: "seat-model" } },
  position: 0,
}

const agent = {
  refId: "ref",
  label: "GitHub: builder",
  skills: ["typescript"],
  tools: ["read", "edit"],
  mcpServers: ["all"],
} as AgentDefinition

describe("seat resolution", () => {
  it("resolves an agent and applies tri-state narrowing and seat runtime", () => {
    const resolved = resolveSeat(seat, pod, [agent], {
      accountId: "inherited",
      modelId: "inherited",
    })
    expect(resolved.address).toBe("builder@implementation")
    expect(resolved.status).toBe("resolved")
    expect(resolved.skills).toEqual([])
    expect(resolved.tools).toEqual(["read", "edit"])
    expect(resolved.mcpServers).toEqual(["docs"])
    expect(resolved.runtime?.accountId).toBe("seat-account")
  })

  it("distinguishes vacant from unresolved seats", () => {
    expect(resolveSeat({ ...seat, agentRefId: null }, pod, []).status).toBe("vacant")
    expect(resolveSeat(seat, pod, []).status).toBe("unresolved")
  })
})
