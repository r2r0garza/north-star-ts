import { tmpdir } from "os"
import Database from "better-sqlite3"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { runMigrations } from "../db/migrations"
import { sqliteLoadsForTests } from "../test/sqlite"
import type { AgentDefinition } from "../agent/agents/types"

// Processes sunset (plan 106.9): a Process becomes a user story playbook by
// reference, its agents can be rebound to seat roles, and Quick run binds
// those roles solo.

const sqliteLoads = sqliteLoadsForTests()

let db: Database.Database
vi.mock("../db/connection", () => ({ getDb: () => db }))
vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getAppPath: () => tmpdir() },
}))

import * as playbooks from "../db/repositories/playbooks"
import * as processes from "../db/repositories/processes"
import * as rigs from "../db/repositories/rigs"
import {
  buildSoloBindings,
  convertAgentsToSeatRoles,
  importProcessAsPlaybook,
  listAgentsForRoleConversion,
  quickRunRoles,
  startQuickRun,
  suggestRole,
} from "./playbook-import"

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
})

function agent(name: string): AgentDefinition {
  return {
    name,
    label: name,
    refId: `agentref:v1:${name}`,
  } as AgentDefinition
}

// Two phases: a builder agent, then a reviewer agent.
function seedProcess() {
  const definition = processes.createProcessDefinition({ name: "Ship it" })
  const build = processes.createPhase({
    processId: definition.id,
    key: "build",
    name: "Build",
    position: 0,
  })
  const review = processes.createPhase({
    processId: definition.id,
    key: "review",
    name: "Review",
    position: 1,
  })
  processes.createPhaseAgent({
    phaseId: build.id,
    agentName: "agentref:v1:dev-bot",
    skills: ["tdd"],
    position: 0,
  })
  processes.createPhaseAgent({
    phaseId: review.id,
    agentName: "agentref:v1:reviewer",
    position: 0,
  })
  return { definition, build, review }
}

describe("suggestRole", () => {
  it("maps common agent names to Mission Control roles", () => {
    expect(suggestRole("QA Tester")).toBe("qa")
    expect(suggestRole("code-reviewer")).toBe("qa")
    expect(suggestRole("Tech Lead")).toBe("lead")
    expect(suggestRole("dev-bot")).toBe("builder")
    expect(suggestRole("Docs Writer")).toBe("docs-writer")
  })
})

describe.skipIf(!sqliteLoads)("importProcessAsPlaybook", () => {
  it("points a user story playbook at the same definition, once", () => {
    const { definition } = seedProcess()
    const playbook = importProcessAsPlaybook(definition.id)
    expect(playbook.altitude).toBe("user_story")
    expect(playbook.hooks).toEqual([
      expect.objectContaining({
        hook: "run",
        processId: definition.id,
        ownsProcess: false,
      }),
    ])
    expect(importProcessAsPlaybook(definition.id).id).toBe(playbook.id)
    expect(playbooks.listPlaybooks()).toHaveLength(1)
    // Still a Process in the legacy list, not a hidden playbook step.
    expect(playbooks.listPlaybookProcessIds()).not.toContain(definition.id)
  })

  it("keeps the Process when the playbook is deleted", () => {
    const { definition } = seedProcess()
    const playbook = importProcessAsPlaybook(definition.id)
    playbooks.deletePlaybook(playbook.id)
    expect(processes.getProcessDefinition(definition.id)).toBeDefined()
  })

  it("explains why a Process a playbook runs can't be deleted", () => {
    const { definition } = seedProcess()
    importProcessAsPlaybook(definition.id)
    expect(() => processes.deleteProcessDefinition(definition.id)).toThrow(
      /playbook "Ship it" runs this process/
    )
  })

  it("still deletes the steps a playbook owns", () => {
    const playbook = playbooks.createPlaybook({
      name: "Own steps",
      altitude: "user_story",
    })
    const withHook = playbooks.createHookProcess(playbook.id, "run")
    const processId = withHook.hooks[0].processId
    expect(withHook.hooks[0].ownsProcess).toBe(true)
    expect(playbooks.listPlaybookProcessIds()).toContain(processId)
    playbooks.deletePlaybook(playbook.id)
    expect(processes.getProcessDefinition(processId)).toBeUndefined()
  })
})

describe.skipIf(!sqliteLoads)("convertAgentsToSeatRoles", () => {
  it("suggests a role per distinct agent", () => {
    const { definition } = seedProcess()
    const rows = listAgentsForRoleConversion(definition.id, [
      agent("dev-bot"),
      agent("reviewer"),
    ])
    expect(rows).toEqual([
      expect.objectContaining({
        agentName: "agentref:v1:dev-bot",
        suggestedRole: "builder",
        phaseCount: 1,
      }),
      expect.objectContaining({
        agentName: "agentref:v1:reviewer",
        suggestedRole: "qa",
        phaseCount: 1,
      }),
    ])
  })

  it("rewrites mapped rows to roles, keeping each row an agent XOR a role", () => {
    const { definition, build, review } = seedProcess()
    const rig = rigs.createRig({ name: "Team" })
    const pod = rigs.createPod({
      rigId: rig.id,
      key: "delivery",
      name: "Delivery",
    })
    rigs.createSeat({ podId: pod.id, key: "builder", role: "builder" })

    const result = convertAgentsToSeatRoles({
      processId: definition.id,
      mapping: { "agentref:v1:dev-bot": "Builder", "agentref:v1:reviewer": "" },
      rigId: rig.id,
    })
    expect(result).toEqual({ converted: 1, missingRoles: [] })

    const [built] = processes.listPhaseAgents(build.id)
    expect(built).toMatchObject({
      agentName: null,
      seatRole: "builder",
      skills: ["tdd"],
    })
    const [reviewed] = processes.listPhaseAgents(review.id)
    expect(reviewed).toMatchObject({
      agentName: "agentref:v1:reviewer",
      seatRole: null,
    })
    expect(quickRunRoles(definition.id)).toEqual(["builder"])
  })

  it("reports roles the chosen rig lacks", () => {
    const { definition } = seedProcess()
    const rig = rigs.createRig({ name: "Empty" })
    const result = convertAgentsToSeatRoles({
      processId: definition.id,
      mapping: { "agentref:v1:reviewer": "qa" },
      rigId: rig.id,
    })
    expect(result.missingRoles).toEqual(["qa"])
  })

  it("rejects an invalid role key", () => {
    const { definition } = seedProcess()
    expect(() =>
      convertAgentsToSeatRoles({
        processId: definition.id,
        mapping: { "agentref:v1:reviewer": "QA team!" },
      })
    ).toThrow(/Seat role/)
  })
})

describe("buildSoloBindings", () => {
  it("binds each role to one seat in a solo pod", () => {
    const snapshot = buildSoloBindings({
      roles: ["builder", "qa"],
      roleAgents: {
        builder: "agentref:v1:dev-bot",
        qa: "agentref:v1:reviewer",
      },
      agents: [agent("dev-bot"), agent("reviewer")],
    })
    expect(snapshot.roles).toEqual({
      builder: ["builder@solo"],
      qa: ["qa@solo"],
    })
    expect(snapshot.seats["qa@solo"]).toMatchObject({
      role: "qa",
      agentName: "agentref:v1:reviewer",
      skills: null,
    })
  })

  it("fails before the run when a role has no agent", () => {
    expect(() =>
      buildSoloBindings({
        roles: ["builder", "qa"],
        roleAgents: { builder: "agentref:v1:dev-bot" },
        agents: [agent("dev-bot")],
      })
    ).toThrow(/Pick an agent for the qa role/)
  })
})

describe.skipIf(!sqliteLoads)("startQuickRun", () => {
  it("starts an ordinary run, with solo bindings only for role-bound steps", async () => {
    const { definition } = seedProcess()
    const startRun = vi.fn(async (input) => ({ id: "run-1", ...input }))
    const deps = {
      loadAgents: async () => [agent("dev-bot"), agent("reviewer")],
      startRun,
    }

    await startQuickRun(deps, {
      processId: definition.id,
      objective: "Add a button",
      workspacePath: "/tmp/project",
    })
    expect(startRun).toHaveBeenLastCalledWith(
      expect.objectContaining({
        processId: definition.id,
        sourceConversationId: null,
        workspacePath: "/tmp/project",
        seatBindings: null,
      })
    )

    convertAgentsToSeatRoles({
      processId: definition.id,
      mapping: { "agentref:v1:dev-bot": "builder" },
    })
    await startQuickRun(deps, {
      processId: definition.id,
      objective: "Add a button",
      workspacePath: "/tmp/project",
      roleAgents: { builder: "agentref:v1:dev-bot" },
    })
    expect(startRun.mock.lastCall?.[0].seatBindings?.roles).toEqual({
      builder: ["builder@solo"],
    })
  })

  it("requires a working directory", async () => {
    const { definition } = seedProcess()
    await expect(
      startQuickRun(
        { loadAgents: async () => [], startRun: vi.fn() },
        { processId: definition.id, objective: "", workspacePath: " " }
      )
    ).rejects.toThrow(/working directory/)
  })
})
