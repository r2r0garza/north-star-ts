import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { randomUUID } from "crypto"
import { runMigrations } from "../../db/migrations"
import { sqliteLoadsForTests } from "../../test/sqlite"

const sqliteLoads = sqliteLoadsForTests()

let db: Database.Database
vi.mock("../../db/connection", () => ({ getDb: () => db }))

import * as processes from "../../db/repositories/processes"
import {
  createCheckpoint,
  listCheckpoints,
} from "../../db/repositories/task-checkpoints"
import {
  FANOUT_CHECKPOINT_LABEL,
  EACH_SUBTASK_CHECKPOINT_LABEL,
  SUBPROCESS_CHECKPOINT_LABEL,
} from "./checkpoints"
import {
  ancestorsOf,
  downstreamClosure,
  descendantChildRuns,
  resolveTarget,
  applyFlagBack,
  resetContainerWhole,
  resetRunRecursive,
} from "./flagback"
import type { ProcessGraph } from "../../db/types"

// Backing task row so checkpoints (FK to tasks) attach.
function freshTask(): string {
  const convId = randomUUID()
  const taskId = randomUUID()
  const now = Date.now()
  db.prepare(
    "INSERT INTO conversations (id, mode, title, workspace_id, created_at, updated_at) VALUES (?, 'interactive', NULL, NULL, ?, ?)"
  ).run(convId, now, now)
  db.prepare(
    "INSERT INTO tasks (id, conversation_id, source_conversation_id, title, status, input, result, error, created_at, updated_at) VALUES (?, ?, ?, NULL, 'running', NULL, NULL, NULL, ?, ?)"
  ).run(taskId, convId, convId, now, now)
  return taskId
}

// Build a process definition from a compact phase/edge spec.
function buildProcess(spec: {
  phases: Array<{ key: string; fanOut?: boolean }>
  edges?: Array<[string, string] | [string, string, "on_each_subtask"]>
}): string {
  const def = processes.createProcessDefinition({ name: "T" })
  const byKey = new Map<string, string>()
  spec.phases.forEach((p, i) => {
    const phase = processes.createPhase({
      processId: def.id,
      key: p.key,
      name: p.key.toUpperCase(),
      fanOut: p.fanOut ?? false,
      position: i,
    })
    byKey.set(p.key, phase.id)
  })
  for (const [from, to, trigger] of spec.edges ?? [])
    processes.createEdge({
      processId: def.id,
      fromPhaseId: byKey.get(from)!,
      toPhaseId: byKey.get(to)!,
      trigger,
    })
  return def.id
}

function graphOf(pid: string): ProcessGraph {
  return processes.getProcessGraph(pid)!
}
function phaseId(pid: string, key: string): string {
  return graphOf(pid).phases.find((p) => p.key === key)!.id
}

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
})

describe.skipIf(!sqliteLoads)("flagback — traversal helpers", () => {
  it("ancestorsOf collects transitive upstream, excluding self", () => {
    const pid = buildProcess({
      phases: [{ key: "a" }, { key: "b" }, { key: "c" }],
      edges: [
        ["a", "b"],
        ["b", "c"],
      ],
    })
    const g = graphOf(pid)
    const anc = ancestorsOf(g, phaseId(pid, "c"))
    expect(anc.has(phaseId(pid, "a"))).toBe(true)
    expect(anc.has(phaseId(pid, "b"))).toBe(true)
    expect(anc.has(phaseId(pid, "c"))).toBe(false)
  })

  it("downstreamClosure is transitive over a diamond and includes the seed", () => {
    // a → b, a → c, b → d, c → d
    const pid = buildProcess({
      phases: [{ key: "a" }, { key: "b" }, { key: "c" }, { key: "d" }],
      edges: [
        ["a", "b"],
        ["a", "c"],
        ["b", "d"],
        ["c", "d"],
      ],
    })
    const g = graphOf(pid)
    const closure = downstreamClosure(g, phaseId(pid, "a"))
    expect([...closure].sort()).toEqual(
      [
        phaseId(pid, "a"),
        phaseId(pid, "b"),
        phaseId(pid, "c"),
        phaseId(pid, "d"),
      ].sort()
    )
    // From b: only b and d (not a or c).
    const fromB = downstreamClosure(g, phaseId(pid, "b"))
    expect([...fromB].sort()).toEqual(
      [phaseId(pid, "b"), phaseId(pid, "d")].sort()
    )
  })

  it("downstreamClosure terminates on a mis-authored cycle (visited-set)", () => {
    // a → b → a (a cycle; the DAG has no guard, so the closure must not hang).
    const pid = buildProcess({
      phases: [{ key: "a" }, { key: "b" }],
      edges: [
        ["a", "b"],
        ["b", "a"],
      ],
    })
    const closure = downstreamClosure(graphOf(pid), phaseId(pid, "a"))
    expect([...closure].sort()).toEqual(
      [phaseId(pid, "a"), phaseId(pid, "b")].sort()
    )
  })
})

// A fan-out Implement (children I1/I2/I3) + an on_each_subtask Test consumer
// (instances T1/T2/T3, each stamped with its source child) + a plain Publish
// (on_complete of Test). Returns the ids for assertions.
function buildFanoutScenario(): {
  runId: string
  pid: string
  taskId: string
  implRun: string
  testRun: string
  I: string[]
  T: string[]
} {
  const pid = buildProcess({
    phases: [
      { key: "implement", fanOut: true },
      { key: "test" },
      { key: "publish" },
    ],
    edges: [
      ["implement", "test", "on_each_subtask"],
      ["test", "publish"],
    ],
  })
  const taskId = freshTask()
  const run = processes.createProcessRun({
    processId: pid,
    sourceConversationId: null,
    taskId,
    objective: "obj",
    status: "running",
  })
  const impl = phaseId(pid, "implement")
  const test = phaseId(pid, "test")
  const publish = phaseId(pid, "publish")

  const implRun = processes.createPhaseRun({
    runId: run.id,
    phaseId: impl,
    status: "completed",
  })
  const testRun = processes.createPhaseRun({
    runId: run.id,
    phaseId: test,
    status: "completed",
  })
  // 3 Implement children, 3 Test instances (one per child).
  const I: string[] = []
  const T: string[] = []
  const fanoutSubtasks: Array<{ phaseRunId: string; prompt: string }> = []
  for (let i = 0; i < 3; i++) {
    const child = processes.createPhaseRun({
      runId: run.id,
      phaseId: impl,
      parentId: implRun.id,
      status: "completed",
      title: `sub ${i + 1}`,
    })
    I.push(child.id)
    fanoutSubtasks.push({ phaseRunId: child.id, prompt: `impl sub ${i + 1}` })
    const inst = processes.createPhaseRun({
      runId: run.id,
      phaseId: test,
      parentId: testRun.id,
      status: "completed",
      sourceChildRunId: child.id,
      title: `test ${i + 1}`,
    })
    T.push(inst.id)
    createCheckpoint({
      taskId,
      label: EACH_SUBTASK_CHECKPOINT_LABEL(testRun.id),
      state: {
        containerPhaseRunId: testRun.id,
        sourceChildRunId: child.id,
        instanceRunId: inst.id,
        prompt: `test sub ${i + 1}`,
      },
    })
  }
  createCheckpoint({
    taskId,
    label: FANOUT_CHECKPOINT_LABEL(implRun.id),
    state: { parentPhaseRunId: implRun.id, subtasks: fanoutSubtasks },
  })
  processes.createPhaseRun({
    runId: run.id,
    phaseId: publish,
    status: "completed",
  })
  return {
    runId: run.id,
    pid,
    taskId,
    implRun: implRun.id,
    testRun: testRun.id,
    I,
    T,
  }
}

describe.skipIf(!sqliteLoads)("flagback — resolveTarget", () => {
  it("accepts an upstream phase by key (whole phase)", () => {
    const pid = buildProcess({
      phases: [{ key: "a" }, { key: "b" }],
      edges: [["a", "b"]],
    })
    const taskId = freshTask()
    const run = processes.createProcessRun({
      processId: pid,
      sourceConversationId: null,
      taskId,
      objective: "o",
      status: "running",
    })
    processes.createPhaseRun({
      runId: run.id,
      phaseId: phaseId(pid, "a"),
      status: "completed",
    })
    const bRun = processes.createPhaseRun({
      runId: run.id,
      phaseId: phaseId(pid, "b"),
      status: "running",
    })
    const res = resolveTarget(graphOf(pid), run.id, bRun, {
      targetPhaseKey: "a",
    })
    expect("error" in res).toBe(false)
    expect("targetPhaseId" in res && res.targetPhaseId).toBe(phaseId(pid, "a"))
    expect(
      ("targetChildRunId" in res && res.targetChildRunId) || undefined
    ).toBeUndefined()
  })

  it("resolves an on_each_subtask instance's flag to its own source child", () => {
    const s = buildFanoutScenario()
    const t1 = processes.getPhaseRun(s.T[0])!
    const res = resolveTarget(graphOf(s.pid), s.runId, t1, {
      targetPhaseKey: "implement",
    })
    expect("targetChildRunId" in res && res.targetChildRunId).toBe(s.I[0])
  })

  it("rejects a forward target, unknown key, and self", () => {
    const pid = buildProcess({
      phases: [{ key: "a" }, { key: "b" }],
      edges: [["a", "b"]],
    })
    const taskId = freshTask()
    const run = processes.createProcessRun({
      processId: pid,
      sourceConversationId: null,
      taskId,
      objective: "o",
      status: "running",
    })
    const aRun = processes.createPhaseRun({
      runId: run.id,
      phaseId: phaseId(pid, "a"),
      status: "running",
    })
    processes.createPhaseRun({
      runId: run.id,
      phaseId: phaseId(pid, "b"),
      status: "pending",
    })
    // a flagging b (forward) → rejected.
    expect(
      "error" in
        resolveTarget(graphOf(pid), run.id, aRun, { targetPhaseKey: "b" })
    ).toBe(true)
    // unknown key.
    expect(
      "error" in
        resolveTarget(graphOf(pid), run.id, aRun, { targetPhaseKey: "zzz" })
    ).toBe(true)
    // self.
    expect(
      "error" in
        resolveTarget(graphOf(pid), run.id, aRun, { targetPhaseKey: "a" })
    ).toBe(true)
  })

  it("rejects targeting a non-completed phase", () => {
    const pid = buildProcess({
      phases: [{ key: "a" }, { key: "b" }],
      edges: [["a", "b"]],
    })
    const taskId = freshTask()
    const run = processes.createProcessRun({
      processId: pid,
      sourceConversationId: null,
      taskId,
      objective: "o",
      status: "running",
    })
    processes.createPhaseRun({
      runId: run.id,
      phaseId: phaseId(pid, "a"),
      status: "running", // NOT completed
    })
    const bRun = processes.createPhaseRun({
      runId: run.id,
      phaseId: phaseId(pid, "b"),
      status: "running",
    })
    expect(
      "error" in
        resolveTarget(graphOf(pid), run.id, bRun, { targetPhaseKey: "a" })
    ).toBe(true)
  })
})

describe.skipIf(!sqliteLoads)("flagback — descendantChildRuns", () => {
  it("follows source_child_run_id forward, excluding siblings", () => {
    const s = buildFanoutScenario()
    const desc = descendantChildRuns(s.runId, s.I[0])
    expect(desc.map((d) => d.id)).toEqual([s.T[0]]) // only T1, not T2/T3
  })
})

describe.skipIf(!sqliteLoads)("flagback — applyFlagBack", () => {
  const statusOf = (id: string) => processes.getPhaseRun(id)?.status

  it("whole non-container target + downstream all reset to pending", () => {
    // a → b → c, all completed; flag a whole.
    const pid = buildProcess({
      phases: [{ key: "a" }, { key: "b" }, { key: "c" }],
      edges: [
        ["a", "b"],
        ["b", "c"],
      ],
    })
    const taskId = freshTask()
    const run = processes.createProcessRun({
      processId: pid,
      sourceConversationId: null,
      taskId,
      objective: "o",
      status: "running",
    })
    const a = processes.createPhaseRun({
      runId: run.id,
      phaseId: phaseId(pid, "a"),
      status: "completed",
    })
    const b = processes.createPhaseRun({
      runId: run.id,
      phaseId: phaseId(pid, "b"),
      status: "completed",
    })
    const c = processes.createPhaseRun({
      runId: run.id,
      phaseId: phaseId(pid, "c"),
      status: "completed",
    })

    applyFlagBack({
      taskId,
      runId: run.id,
      graph: graphOf(pid),
      target: { targetPhaseId: phaseId(pid, "a") },
      reason: "wrong approach",
    })

    expect(statusOf(a.id)).toBe("pending")
    expect(statusOf(b.id)).toBe("pending")
    expect(statusOf(c.id)).toBe("pending")
    // The target carries the reason; downstream carries a generic note.
    expect(processes.getPhaseRun(a.id)?.reworkNote).toBe("wrong approach")
    expect(processes.getPhaseRun(b.id)?.reworkNote).toContain("upstream")
    expect(processes.getPhaseRun(a.id)?.reworkRound).toBe(1)
  })

  it("per-child: resets only the flagged sub-task + its instance; siblings untouched", () => {
    const s = buildFanoutScenario()
    applyFlagBack({
      taskId: s.taskId,
      runId: s.runId,
      graph: graphOf(s.pid),
      target: {
        targetPhaseId: phaseId(s.pid, "implement"),
        targetChildRunId: s.I[0],
      },
      reason: "sub-task 1 is broken",
    })

    // I1 reset; I2/I3 untouched.
    expect(statusOf(s.I[0])).toBe("pending")
    expect(statusOf(s.I[1])).toBe("completed")
    expect(statusOf(s.I[2])).toBe("completed")
    // The Implement container is reopened to running.
    expect(statusOf(s.implRun)).toBe("running")
    // T1 (descended from I1) is DELETED; T2/T3 stand.
    expect(processes.getPhaseRun(s.T[0])).toBeUndefined()
    expect(statusOf(s.T[1])).toBe("completed")
    expect(statusOf(s.T[2])).toBe("completed")
    // The Test container is reopened so a fresh T1 can be re-triggered.
    expect(statusOf(s.testRun)).toBe("running")
    // The reworked child's prompt carries the reason (fresh fanout: checkpoint).
    const label = FANOUT_CHECKPOINT_LABEL(s.implRun)
    const cps = listCheckpoints(s.taskId).filter((c) => c.label === label)
    const latest = cps[cps.length - 1].state as {
      subtasks: Array<{ phaseRunId: string; prompt: string }>
    }
    expect(latest.subtasks[0].prompt).toContain("sub-task 1 is broken")
    // T1's eachsubtask checkpoint row was removed (so it re-triggers fresh).
    const eachRows = listCheckpoints(s.taskId).filter(
      (c) => c.label === EACH_SUBTASK_CHECKPOINT_LABEL(s.testRun)
    )
    expect(
      eachRows.some(
        (c) => (c.state as { instanceRunId?: string }).instanceRunId === s.T[0]
      )
    ).toBe(false)
    expect(
      eachRows.some(
        (c) => (c.state as { instanceRunId?: string }).instanceRunId === s.T[1]
      )
    ).toBe(true)
  })

  it("whole fan-out target: children deleted + fanout checkpoint cleared + parent pending", () => {
    const s = buildFanoutScenario()
    applyFlagBack({
      taskId: s.taskId,
      runId: s.runId,
      graph: graphOf(s.pid),
      target: { targetPhaseId: phaseId(s.pid, "implement") }, // whole, no child
      reason: "re-plan the whole thing",
    })
    // All Implement children gone; parent pending (re-decomposes).
    expect(processes.getPhaseRun(s.I[0])).toBeUndefined()
    expect(processes.getPhaseRun(s.I[1])).toBeUndefined()
    expect(statusOf(s.implRun)).toBe("pending")
    // fanout: checkpoint cleared.
    const fanoutRows = listCheckpoints(s.taskId).filter(
      (c) => c.label === FANOUT_CHECKPOINT_LABEL(s.implRun)
    )
    expect(fanoutRows).toHaveLength(0)
    // Downstream Test container is also reset whole (children deleted, checkpoints cleared).
    expect(statusOf(s.testRun)).toBe("pending")
    expect(processes.getPhaseRun(s.T[0])).toBeUndefined()
    const eachRows = listCheckpoints(s.taskId).filter(
      (c) => c.label === EACH_SUBTASK_CHECKPOINT_LABEL(s.testRun)
    )
    expect(eachRows).toHaveLength(0)
  })
})

describe.skipIf(!sqliteLoads)(
  "flagback — resetRunRecursive (plan 038.2)",
  () => {
    // A parent whose `impl` phase runs a two-phase sub-process (inner1 → inner2),
    // with the nested run already driven to some terminal state. Returns the ids.
    function buildParentWithSub(): {
      taskId: string
      parentRunId: string
      subId: string
      implRunId: string
      childRunId: string
      inner1RunId: string
      inner2RunId: string
    } {
      const taskId = freshTask()
      const sub = processes.createProcessDefinition({ name: "Sub" })
      const in1 = processes.createPhase({
        processId: sub.id,
        key: "inner1",
        name: "Inner1",
        position: 0,
      })
      const in2 = processes.createPhase({
        processId: sub.id,
        key: "inner2",
        name: "Inner2",
        position: 1,
      })
      processes.createEdge({
        processId: sub.id,
        fromPhaseId: in1.id,
        toPhaseId: in2.id,
      })
      const parent = processes.createProcessDefinition({ name: "Parent" })
      const impl = processes.createPhase({
        processId: parent.id,
        key: "impl",
        name: "Implement",
        subprocessId: sub.id,
        position: 0,
      })
      const parentRun = processes.createProcessRun({
        processId: parent.id,
        sourceConversationId: null,
        taskId,
        objective: "obj",
        status: "failed",
      })
      const implRun = processes.createPhaseRun({
        runId: parentRun.id,
        phaseId: impl.id,
        status: "running", // child threw → phase-run left running
      })
      const childRun = processes.createProcessRun({
        processId: sub.id,
        sourceConversationId: null,
        taskId,
        objective: "obj",
        parentPhaseRunId: implRun.id,
        status: "failed",
      })
      const inner1Run = processes.createPhaseRun({
        runId: childRun.id,
        phaseId: in1.id,
        status: "completed",
      })
      const inner2Run = processes.createPhaseRun({
        runId: childRun.id,
        phaseId: in2.id,
        status: "failed",
      })
      processes.updatePhaseRun(inner2Run.id, { error: "boom" })
      return {
        taskId,
        parentRunId: parentRun.id,
        subId: sub.id,
        implRunId: implRun.id,
        childRunId: childRun.id,
        inner1RunId: inner1Run.id,
        inner2RunId: inner2Run.id,
      }
    }

    it("frontier mode resets a failed nested run's failed frontier, sparing completed child phases", () => {
      const s = buildParentWithSub()
      resetRunRecursive({
        taskId: s.taskId,
        run: processes.getProcessRun(s.parentRunId)!,
        graph: graphOf(processes.getProcessRun(s.parentRunId)!.processId!),
        mode: "frontier",
      })
      // The sub-process phase-run reset; the child run flipped running; the child's
      // FAILED phase reset to pending; the child's COMPLETED phase left intact.
      expect(processes.getPhaseRun(s.implRunId)!.status).toBe("pending")
      expect(processes.getProcessRun(s.childRunId)!.status).toBe("running")
      expect(processes.getPhaseRun(s.inner2RunId)!.status).toBe("pending")
      expect(processes.getPhaseRun(s.inner2RunId)!.error).toBeNull()
      expect(processes.getPhaseRun(s.inner1RunId)!.status).toBe("completed")
    })

    it("whole mode resets ALL nested phases and injects the note into the child's entry phase", () => {
      const s = buildParentWithSub()
      // Mark the child fully completed to prove `whole` resets even completed phases.
      processes.updatePhaseRun(s.inner2RunId, {
        status: "completed",
        error: null,
      })
      processes.updateProcessRun(s.childRunId, { status: "completed" })

      resetRunRecursive({
        taskId: s.taskId,
        run: processes.getProcessRun(s.parentRunId)!,
        graph: graphOf(processes.getProcessRun(s.parentRunId)!.processId!),
        mode: "whole",
        note: "make it blue",
      })
      expect(processes.getPhaseRun(s.inner1RunId)!.status).toBe("pending")
      expect(processes.getPhaseRun(s.inner2RunId)!.status).toBe("pending")
      // inner1 is the child's ENTRY phase (no incoming edge) → carries the note;
      // inner2 (downstream) gets a generic "upstream reworked" note, not the raw one.
      expect(processes.getPhaseRun(s.inner1RunId)!.reworkNote).toBe(
        "make it blue"
      )
      expect(processes.getPhaseRun(s.inner2RunId)!.reworkNote).not.toBe(
        "make it blue"
      )
    })

    it("skips recursion cleanly when the sub-process phase never spawned a child", () => {
      const s = buildParentWithSub()
      // Delete the child run so getProcessRunByParentPhaseRunId returns none.
      db.prepare("DELETE FROM process_runs WHERE id = ?").run(s.childRunId)
      // The impl phase-run is `running` (not resettable) and now has no child → it is
      // left as-is in frontier mode, and the call does not throw.
      expect(() =>
        resetRunRecursive({
          taskId: s.taskId,
          run: processes.getProcessRun(s.parentRunId)!,
          graph: graphOf(processes.getProcessRun(s.parentRunId)!.processId!),
          mode: "frontier",
        })
      ).not.toThrow()
      expect(processes.getPhaseRun(s.implRunId)!.status).toBe("running")
    })
  }
)

describe.skipIf(!sqliteLoads)(
  "flagback — clearContainerCheckpoints (plan 038.3)",
  () => {
    it("resetContainerWhole clears each per-child subprocess: checkpoint", () => {
      // A combined fan-out + sub-process container with two children, each having
      // written a subprocess:<childRunId> accelerator checkpoint. A whole reset must
      // delete those rows too (else a re-decomposed container re-attaches to stale
      // nested runs).
      const pid = buildProcess({ phases: [{ key: "c", fanOut: true }] })
      const taskId = freshTask()
      const run = processes.createProcessRun({
        processId: pid,
        sourceConversationId: null,
        taskId,
        objective: "o",
        status: "running",
      })
      const container = processes.createPhaseRun({
        runId: run.id,
        phaseId: phaseId(pid, "c"),
        status: "running",
      })
      const child1 = processes.createPhaseRun({
        runId: run.id,
        phaseId: phaseId(pid, "c"),
        parentId: container.id,
        status: "completed",
      })
      const child2 = processes.createPhaseRun({
        runId: run.id,
        phaseId: phaseId(pid, "c"),
        parentId: container.id,
        status: "completed",
      })
      createCheckpoint({
        taskId,
        label: FANOUT_CHECKPOINT_LABEL(container.id),
        state: { parentPhaseRunId: container.id, subtasks: [] },
      })
      for (const child of [child1, child2])
        createCheckpoint({
          taskId,
          label: SUBPROCESS_CHECKPOINT_LABEL(child.id),
          state: { parentPhaseRunId: child.id, childRunId: randomUUID() },
        })

      resetContainerWhole(taskId, run.id, container, "re-plan")

      // Children gone; container pending; fanout: + both subprocess: rows cleared.
      expect(processes.getPhaseRun(child1.id)).toBeUndefined()
      expect(processes.getPhaseRun(child2.id)).toBeUndefined()
      expect(processes.getPhaseRun(container.id)!.status).toBe("pending")
      const remaining = listCheckpoints(taskId)
      expect(remaining).toHaveLength(0)
    })
  }
)
