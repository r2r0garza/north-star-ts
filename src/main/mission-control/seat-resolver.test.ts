import { describe, expect, it } from "vitest"
import type { AgentDefinition } from "../agent/agents/types"
import type { RigGraph, RigPod, RigSeat } from "../db/types"
import {
  collectSeatRoles,
  resolveSeatBindings,
  SeatResolutionError,
} from "./seat-resolver"
import { renderSeatContext } from "./seat-context"

const agents = ["a", "b", "c"].map((name) => ({
  name,
  refId: `ref:${name}`,
  label: `Agent ${name}`,
})) as unknown as AgentDefinition[]

function pod(id: string, key: string, position: number): RigPod {
  return {
    id,
    rigId: "rig",
    key,
    name: key,
    missionStatement: `${key} mission`,
    cultureMd: `${key} culture`,
    leadSeatId: null,
    position,
  }
}

function seat(
  id: string,
  podId: string,
  key: string,
  role: string,
  agent: string | null,
  position = 0
): RigSeat {
  return {
    id,
    podId,
    key,
    role,
    charter: `${key} charter`,
    agentRefId: agent ? `ref:${agent}` : null,
    agentLabel: null,
    skills: null,
    tools: null,
    mcpServers: null,
    decisionRights: [],
    runtimeConfig: null,
    position,
  }
}

const rig: RigGraph = {
  rig: {
    id: "rig",
    name: "Rig",
    description: null,
    cultureMd: "rig culture",
    createdAt: 0,
    updatedAt: 0,
  },
  pods: [pod("p-lead", "orchestration", 0), pod("p-impl", "implementation", 1)],
  seats: [
    seat("s-lead", "p-lead", "lead", "lead", "c"),
    seat("s-b1", "p-impl", "builder-1", "builder", "a", 0),
    seat("s-b2", "p-impl", "builder-2", "builder", "b", 1),
    seat("s-qa", "p-impl", "qa", "qa", null),
  ],
  oversight: [
    { id: "o", rigId: "rig", overseerPodId: "p-lead", overseenPodId: "p-impl" },
  ],
}

describe("resolveSeatBindings", () => {
  it("binds every seat with the role in the pod, in position order", () => {
    const snapshot = resolveSeatBindings({
      rig,
      podKey: "implementation",
      roles: ["builder"],
      agents,
      intentChain: "why",
    })
    expect(snapshot.roles.builder).toEqual([
      "builder-1@implementation",
      "builder-2@implementation",
    ])
    expect(snapshot.seats["builder-2@implementation"]).toMatchObject({
      agentName: "ref:b",
      podCulture: "implementation culture",
    })
  })

  it("falls back to an overseer pod and defaults to the working pod", () => {
    const snapshot = resolveSeatBindings({
      rig,
      podKey: null,
      roles: ["lead"],
      agents,
      intentChain: "",
    })
    expect(snapshot.podKey).toBe("implementation")
    expect(snapshot.roles.lead).toEqual(["lead@orchestration"])
  })

  it("names every missing or unusable role", () => {
    try {
      resolveSeatBindings({
        rig,
        podKey: "implementation",
        roles: ["designer", "qa"],
        agents,
        intentChain: "",
      })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(SeatResolutionError)
      expect((err as SeatResolutionError).problems).toEqual([
        'No seat has role "designer" in pod "implementation" or the pods overseeing it.',
        'Role "qa" has no usable seat for pod "implementation": qa@implementation is vacant.',
      ])
    }
  })

  it("rejects an unknown pod", () => {
    expect(() =>
      resolveSeatBindings({ rig, podKey: "nope", roles: [], agents, intentChain: "" })
    ).toThrow(/no pod "nope"/)
  })

  it("renders context layers in order", () => {
    const snapshot = resolveSeatBindings({
      rig,
      podKey: "implementation",
      roles: ["builder"],
      agents,
      intentChain: "Initiative intent",
    })
    const text = renderSeatContext(
      snapshot,
      snapshot.seats["builder-1@implementation"]
    )
    const order = ["builder-1 charter", "rig culture", "implementation culture", "Initiative intent"].map(
      (fragment) => text.indexOf(fragment)
    )
    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((x, y) => x - y)).toEqual(order)
  })
})

describe("collectSeatRoles", () => {
  it("includes roles from nested sub-process definitions once", () => {
    const graph = (id: string, roles: string[], subprocessId?: string) => ({
      definition: { id } as never,
      phases: subprocessId ? [{ subprocessId } as never] : [],
      agents: roles.map((seatRole) => ({ seatRole }) as never),
      edges: [],
    })
    const graphs = {
      outer: graph("outer", ["builder"], "inner"),
      inner: graph("inner", ["qa", "builder"], "outer"),
    }
    expect(
      collectSeatRoles(graphs.outer, (id) => graphs[id as "outer" | "inner"])
    ).toEqual(["builder", "qa"])
  })
})
