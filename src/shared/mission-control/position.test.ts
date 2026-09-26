import { describe, expect, it } from "vitest"
import { budgetMeters, type BudgetUsage } from "./budgets"
import {
  computePosition,
  positionFingerprint,
  renderPosition,
  type PositionInput,
  type PositionMissionInput,
  type PositionRunInput,
  type PositionSliceInput,
} from "./position"

const NO_USAGE: BudgetUsage = {
  maxConcurrentSlices: 0,
  maxSliceAttempts: 0,
  maxPlanRevisionsPerMission: 0,
  maxAgentSlicesPerMission: 0,
  maxMessagesPerHour: 0,
  maxActiveHours: 0,
}

function mission(
  id: string,
  over: Partial<PositionMissionInput> = {}
): PositionMissionInput {
  return {
    id,
    key: id,
    name: `Mission ${id}`,
    status: "planned",
    position: Number(id.replace(/\D/g, "")) || 0,
    integrationBranch: null,
    mergePolicy: "manual",
    dodReviewed: false,
    hooks: [],
    ...over,
  }
}

let order = 0
function slice(
  id: string,
  missionId = "m1",
  over: Partial<PositionSliceInput> = {}
): PositionSliceInput {
  return {
    id,
    missionId,
    key: id,
    title: `Slice ${id}`,
    status: "draft",
    attempts: 0,
    podKey: null,
    position: order++,
    touchHints: [],
    acceptanceCount: 1,
    proofVerdict: null,
    ...over,
  }
}

function run(
  hook: PositionRunInput["hook"],
  status: PositionRunInput["status"],
  over: Partial<PositionRunInput> = {}
): PositionRunInput {
  return {
    id: `${hook}-${status}-${order++}`,
    hook,
    missionId: null,
    sliceId: null,
    status,
    isolated: false,
    createdAt: order,
    ...over,
  }
}

function input(over: Partial<PositionInput> = {}): PositionInput {
  return {
    initiative: {
      id: "i1",
      status: "active",
      driveMode: "autopilot",
      hooks: [],
      defaultPodKey: "impl",
    },
    missions: [mission("m1", { status: "active" })],
    slices: [],
    edges: [],
    runs: [],
    mergeQueue: [],
    proposals: [],
    escalations: [],
    workspace: { mode: "git", busy: false },
    pods: [{ key: "impl", builderSeats: 2 }],
    lead: { address: "lead@orch", rights: ["assign_slice", "revise_plan", "accept_proof"] },
    limits: { maxConcurrentSlices: 3, maxSliceAttempts: 3 },
    budgets: budgetMeters({}, NO_USAGE),
    ...over,
  }
}

const edge = (from: string, to: string, missionId = "m1") => ({
  missionId,
  fromSliceId: from,
  toSliceId: to,
})

describe("computePosition — planning", () => {
  it("leaves a due hook to the user outside autopilot", () => {
    const p = computePosition(
      input({
        initiative: { ...input().initiative, driveMode: "copilot", hooks: ["plan"] },
        missions: [mission("m1")],
      })
    )
    expect(p.maneuver.kind).toBe("run_hook")
    expect(p.pendingDecisions).toEqual([
      expect.objectContaining({ key: "hook_due:plan:", kind: "hook_due", owner: "user" }),
    ])
  })

  it("runs the planning hook when nothing is planned yet", () => {
    const p = computePosition(
      input({
        initiative: { ...input().initiative, hooks: ["plan"] },
        missions: [mission("m1")],
      })
    )
    expect(p.maneuver.kind).toBe("run_hook")
    expect(p.initiative.nextHook).toMatchObject({ hook: "plan", missionId: null })
  })

  it("waits for the planning proposal, which only the user applies", () => {
    const p = computePosition(
      input({
        initiative: { ...input().initiative, hooks: ["plan"] },
        missions: [mission("m1")],
        runs: [run("plan", "completed")],
        proposals: [{ id: "p1", kind: "plan", proposer: "lead@orch", summary: "Plan" }],
      })
    )
    expect(p.maneuver.kind).toBe("decide")
    expect(p.pendingDecisions).toEqual([
      expect.objectContaining({ key: "proposal:p1", kind: "plan_proposal", owner: "user" }),
    ])
  })

  it("asks the user when planning finished without a proposal or failed", () => {
    const done = computePosition(
      input({
        initiative: { ...input().initiative, hooks: ["plan"] },
        runs: [run("plan", "completed")],
      })
    )
    expect(done.pendingDecisions.map((d) => d.kind)).toEqual(["no_plan"])
    const failed = computePosition(
      input({
        initiative: { ...input().initiative, hooks: ["plan"] },
        runs: [run("plan", "failed")],
      })
    )
    expect(failed.pendingDecisions.map((d) => d.kind)).toEqual(["hook_failed"])
  })

  it("waits while planning runs", () => {
    const p = computePosition(
      input({
        initiative: { ...input().initiative, hooks: ["plan"] },
        runs: [run("plan", "running")],
      })
    )
    expect(p.maneuver.kind).toBe("wait")
    expect(p.initiative.runningHook?.hook).toBe("plan")
  })
})

describe("computePosition — waves and dispatch", () => {
  it("dispatches the first wave, critical path first, then position", () => {
    // a → c, b independent: critical path a, c. Both a and b are ready.
    const p = computePosition(
      input({
        slices: [slice("b"), slice("a"), slice("c")],
        edges: [edge("a", "c")],
      })
    )
    expect(p.mission?.ready).toEqual(["b", "a"])
    expect(p.mission?.waiting).toEqual([{ slice: "c", on: ["a"] }])
    expect(p.dispatch.map((d) => d.slice)).toEqual(["a", "b"])
    expect(p.maneuver.kind).toBe("dispatch")
  })

  it("starts a dependent slice only once its predecessor merged", () => {
    const integrating = computePosition(
      input({
        slices: [slice("a", "m1", { status: "integrating" }), slice("c")],
        edges: [edge("a", "c")],
      })
    )
    expect(integrating.dispatch).toEqual([])
    expect(integrating.maneuver.kind).toBe("wait")
    const merged = computePosition(
      input({
        slices: [slice("a", "m1", { status: "done" }), slice("c")],
        edges: [edge("a", "c")],
      })
    )
    expect(merged.dispatch.map((d) => d.slice)).toEqual(["c"])
  })

  it("respects the concurrency budget and pod capacity", () => {
    const three = [slice("a"), slice("b"), slice("c")]
    const capped = computePosition(
      input({
        slices: three,
        limits: { maxConcurrentSlices: 2, maxSliceAttempts: 3 },
      })
    )
    expect(capped.dispatch.map((d) => d.slice)).toEqual(["a", "b"])
    expect(capped.deferred).toEqual([
      { slice: "c", reason: expect.stringContaining("2 user stories at once") },
    ])
    const onePod = computePosition(
      input({ slices: three, pods: [{ key: "impl", builderSeats: 1 }] })
    )
    expect(onePod.dispatch.map((d) => d.slice)).toEqual(["a"])
    expect(onePod.deferred.map((d) => d.reason)).toEqual([
      "pod impl is busy",
      "pod impl is busy",
    ])
  })

  it("counts slices already running against capacity", () => {
    const p = computePosition(
      input({
        slices: [slice("a", "m1", { status: "running" }), slice("b"), slice("c")],
        runs: [run("run", "running", { sliceId: "a", missionId: "m1", isolated: true })],
        limits: { maxConcurrentSlices: 2, maxSliceAttempts: 3 },
      })
    )
    expect(p.capacity.concurrencyFree).toBe(1)
    expect(p.capacity.podsFree.impl).toBe(1)
    expect(p.dispatch.map((d) => d.slice)).toEqual(["b"])
  })

  it("serializes slices with overlapping touch hints", () => {
    const p = computePosition(
      input({
        slices: [
          slice("a", "m1", { touchHints: ["src/billing/**"] }),
          slice("b", "m1", { touchHints: ["src/billing/invoice.ts"] }),
          slice("c", "m1", { touchHints: ["docs/**"] }),
        ],
      })
    )
    expect(p.dispatch.map((d) => d.slice)).toEqual(["a", "c"])
    expect(p.deferred).toEqual([{ slice: "b", reason: "touch hints overlap a" }])
  })

  it("runs one at a time in a non-git workspace, and none while it is busy", () => {
    const single = computePosition(
      input({
        slices: [slice("a"), slice("b")],
        workspace: { mode: "single_flight", busy: false },
      })
    )
    expect(single.dispatch.map((d) => d.slice)).toEqual(["a"])
    const busy = computePosition(
      input({
        slices: [slice("a")],
        workspace: { mode: "single_flight", busy: true },
      })
    )
    expect(busy.dispatch).toEqual([])
  })

  it("holds a slice without acceptance criteria and asks the lead", () => {
    const p = computePosition(input({ slices: [slice("a", "m1", { acceptanceCount: 0 })] }))
    expect(p.dispatch).toEqual([])
    expect(p.mission?.blocked).toEqual([{ slice: "a", reason: "has no acceptance criteria" }])
    expect(p.pendingDecisions[0]).toMatchObject({ kind: "slice_unspecified", owner: "lead" })
  })
})

describe("computePosition — failures and judgment", () => {
  it("retries a slice that stopped without a rejected proof", () => {
    const p = computePosition(
      input({ slices: [slice("a", "m1", { status: "failed", attempts: 1 })] })
    )
    expect(p.mission?.retryable).toEqual(["a"])
    expect(p.dispatch).toEqual([{ slice: "a", retry: true }])
  })

  it("hands a rejected proof to the lead instead of retrying", () => {
    const p = computePosition(
      input({
        slices: [slice("a", "m1", { status: "failed", attempts: 1, proofVerdict: "rejected" })],
      })
    )
    expect(p.dispatch).toEqual([])
    expect(p.pendingDecisions).toEqual([
      expect.objectContaining({ key: "proof_rejected:a:1", owner: "lead" }),
    ])
  })

  it("hands repeated failures (soft) and exhausted attempts (hard) to the lead", () => {
    const soft = computePosition(
      input({ slices: [slice("a", "m1", { status: "failed", attempts: 2 })] })
    )
    expect(soft.pendingDecisions[0]).toMatchObject({ key: "slice_failed:a:2", kind: "slice_failed" })
    expect(soft.dispatch).toEqual([])
    const hard = computePosition(
      input({ slices: [slice("a", "m1", { status: "failed", attempts: 3 })] })
    )
    expect(hard.pendingDecisions[0].summary).toContain("used all 3 attempts")
  })

  it("sends judgment to the user when the lead lacks the right, or in manual drive", () => {
    const noRight = computePosition(
      input({
        lead: { address: "lead@orch", rights: [] },
        slices: [slice("a", "m1", { status: "failed", attempts: 1, proofVerdict: "rejected" })],
      })
    )
    expect(noRight.pendingDecisions[0].owner).toBe("user")
    const manual = computePosition(
      input({
        initiative: { ...input().initiative, driveMode: "manual" },
        slices: [slice("a", "m1", { status: "failed", attempts: 1, proofVerdict: "rejected" })],
      })
    )
    expect(manual.pendingDecisions[0].owner).toBe("user")
  })

  it("reports slices blocked by a cancelled dependency", () => {
    const p = computePosition(
      input({
        slices: [slice("a", "m1", { status: "cancelled" }), slice("b", "m1", { status: "blocked" })],
        edges: [edge("a", "b")],
      })
    )
    expect(p.mission?.blocked).toEqual([
      { slice: "b", reason: "depends on cancelled user story a" },
    ])
    expect(p.pendingDecisions[0]).toMatchObject({ kind: "slice_blocked", owner: "lead" })
  })

  it("surfaces escalated merge conflicts and escalations for the user", () => {
    const p = computePosition(
      input({
        missions: [mission("m1", { status: "integrating", integrationBranch: "mc/i/m1/integration" })],
        slices: [slice("a", "m1", { status: "integrating" })],
        mergeQueue: [{ id: "q1", sliceId: "a", missionId: "m1", status: "conflict", escalated: true }],
        escalations: [{ id: "e1", from: "qa@impl", subject: "Spec is wrong" }],
      })
    )
    expect(p.pendingDecisions.map((d) => [d.kind, d.owner])).toEqual([
      ["escalation", "user"],
      ["merge_conflict", "user"],
    ])
  })
})

describe("computePosition — mission lifecycle", () => {
  it("runs the mission's planning review before its first slice", () => {
    const p = computePosition(
      input({
        missions: [mission("m1", { hooks: ["before_slices"] })],
        slices: [slice("a")],
      })
    )
    expect(p.maneuver.kind).toBe("run_hook")
    expect(p.initiative.nextHook).toMatchObject({ hook: "before_slices", missionId: "m1" })
    expect(p.dispatch).toEqual([])
    const reviewed = computePosition(
      input({
        missions: [mission("m1", { hooks: ["before_slices"] })],
        slices: [slice("a")],
        runs: [run("before_slices", "completed", { missionId: "m1" })],
      })
    )
    expect(reviewed.dispatch.map((d) => d.slice)).toEqual(["a"])
  })

  it("runs the mission review, then asks the lead to judge the DoD", () => {
    const base = {
      missions: [mission("m1", { status: "review", hooks: ["after_all_slices" as const] })],
      slices: [slice("a", "m1", { status: "done" })],
    }
    expect(computePosition(input(base)).initiative.nextHook?.hook).toBe("after_all_slices")
    const reviewed = computePosition(
      input({ ...base, runs: [run("after_all_slices", "completed", { missionId: "m1" })] })
    )
    expect(reviewed.pendingDecisions).toEqual([
      expect.objectContaining({ key: "mission_dod:m1", owner: "lead" }),
    ])
  })

  it("completes a mission with nothing to land once its DoD is judged", () => {
    const p = computePosition(
      input({
        missions: [mission("m1", { status: "review", dodReviewed: true })],
        slices: [slice("a", "m1", { status: "done" })],
      })
    )
    expect(p.maneuver).toMatchObject({ kind: "complete_mission", missionId: "m1" })
    expect(p.mission?.doneConditionMet).toBe(true)
  })

  it("waits on the user to land a mission with an integration branch", () => {
    const p = computePosition(
      input({
        missions: [
          mission("m1", {
            status: "review",
            dodReviewed: true,
            integrationBranch: "mc/i/m1/integration",
            mergePolicy: "local_merge",
          }),
        ],
        slices: [slice("a", "m1", { status: "done" })],
      })
    )
    expect(p.pendingDecisions).toEqual([
      expect.objectContaining({ kind: "mission_landing", owner: "user" }),
    ])
    expect(p.pendingDecisions[0].summary).toContain("approve the merge")
  })

  it("runs the release between missions, then moves to the next mission", () => {
    const base = {
      initiative: { ...input().initiative, hooks: ["between_missions" as const] },
      missions: [mission("m1", { status: "completed" }), mission("m2")],
      slices: [slice("a", "m1", { status: "done" }), slice("b", "m2")],
    }
    const release = computePosition(input(base))
    expect(release.initiative.activeMissionId).toBe("m2")
    expect(release.initiative.nextHook).toMatchObject({ hook: "between_missions", missionId: "m1" })
    const next = computePosition(
      input({ ...base, runs: [run("between_missions", "completed", { missionId: "m1" })] })
    )
    expect(next.dispatch.map((d) => d.slice)).toEqual(["b"])
  })

  it("completes the initiative after the last mission and its completion hook", () => {
    const base = {
      initiative: { ...input().initiative, hooks: ["on_complete" as const] },
      missions: [mission("m1", { status: "completed" })],
      slices: [slice("a", "m1", { status: "done" })],
    }
    expect(computePosition(input(base)).initiative.nextHook?.hook).toBe("on_complete")
    const done = computePosition(
      input({ ...base, runs: [run("on_complete", "completed")] })
    )
    expect(done.maneuver.kind).toBe("complete_initiative")
    expect(done.initiative.complete).toBe(true)
  })

  it("runs the completion hook again after a reopened initiative finishes again", () => {
    const base = {
      initiative: { ...input().initiative, hooks: ["on_complete" as const] },
      missions: [mission("m1", { status: "completed", finishedAt: 500 })],
      slices: [slice("a", "m1", { status: "done" })],
    }
    const earlier = run("on_complete", "completed", { createdAt: 100 })
    expect(computePosition(input({ ...base, runs: [earlier] })).initiative.nextHook?.hook).toBe(
      "on_complete"
    )
    const later = run("on_complete", "completed", { createdAt: 600 })
    expect(computePosition(input({ ...base, runs: [earlier, later] })).maneuver.kind).toBe(
      "complete_initiative"
    )
  })

  it("asks for slices when the active mission is empty", () => {
    const p = computePosition(
      input({
        missions: [mission("m1", { status: "completed" }), mission("m2")],
        slices: [slice("a", "m1", { status: "done" })],
      })
    )
    expect(p.pendingDecisions[0]).toMatchObject({ kind: "mission_empty", owner: "lead" })
  })
})

describe("computePosition — budgets and identity", () => {
  it("raises budget decisions at the soft and hard levels", () => {
    const p = computePosition(
      input({
        slices: [slice("a")],
        budgets: budgetMeters({}, { ...NO_USAGE, maxPlanRevisionsPerMission: 8, maxActiveHours: 8 }),
      })
    )
    expect(p.pendingDecisions.map((d) => [d.key, d.owner])).toEqual([
      ["budget:maxPlanRevisionsPerMission:soft", "lead"],
      ["budget:maxActiveHours:hard", "user"],
    ])
  })

  it("never acts on a finished mission's final numbers", () => {
    const meters = budgetMeters(
      {},
      { ...NO_USAGE, maxPlanRevisionsPerMission: 10 },
      { key: "m1", final: true }
    )
    expect(meters.find((m) => m.key === "maxPlanRevisionsPerMission")).toMatchObject({
      scope: "m1, final",
      final: true,
      level: "hard",
    })
    expect(meters.find((m) => m.key === "maxMessagesPerHour")?.scope).toBe("last hour")
    const p = computePosition(input({ slices: [slice("a")], budgets: meters }))
    expect(p.pendingDecisions).toEqual([])
  })

  it("gives the user an action for each decision they own", () => {
    const judge = computePosition(
      input({
        lead: { address: "lead@orch", rights: ["assign_slice"] },
        missions: [mission("m1", { status: "review" })],
        slices: [slice("a", "m1", { status: "done" })],
      })
    )
    expect(judge.pendingDecisions[0]).toMatchObject({
      kind: "mission_dod",
      owner: "user",
      action: { kind: "judge_mission", missionId: "m1" },
    })
    const hook = computePosition(
      input({
        missions: [mission("m1", { hooks: ["before_slices"] })],
        slices: [slice("a")],
        runs: [run("before_slices", "failed", { missionId: "m1" })],
      })
    )
    expect(hook.pendingDecisions[0].action).toEqual({
      kind: "run_hook",
      hook: "before_slices",
      missionId: "m1",
    })
    const lead = computePosition(
      input({ slices: [slice("a", "m1", { status: "failed", attempts: 3 })] })
    )
    expect(lead.pendingDecisions[0]).toMatchObject({ owner: "lead" })
    expect(lead.pendingDecisions[0].action).toBeUndefined()
  })

  it("fingerprints the same state identically and a changed state differently", () => {
    const state = input({ slices: [slice("a"), slice("b")] })
    expect(positionFingerprint(computePosition(state))).toBe(
      positionFingerprint(computePosition(state))
    )
    const moved = {
      ...state,
      slices: state.slices.map((s) => (s.id === "a" ? { ...s, status: "running" } : s)),
    }
    expect(positionFingerprint(computePosition(moved))).not.toBe(
      positionFingerprint(computePosition(state))
    )
  })

  it("renders a position for a seat", () => {
    const text = renderPosition(
      computePosition(input({ slices: [slice("a"), slice("b")], edges: [edge("a", "b")] }))
    )
    expect(text).toContain("Active milestone: m1")
    expect(text).toContain("Waves: 1) a  2) b")
    expect(text).toContain("Next: Start a.")
  })
})
