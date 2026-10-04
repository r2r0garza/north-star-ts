import { describe, expect, it } from "vitest"
import { budgetMeters, type BudgetUsage } from "./budgets"
import {
  computePosition,
  positionFingerprint,
  renderPosition,
  type PositionInput,
  type PositionMilestoneInput,
  type PositionRunInput,
  type PositionUserStoryInput,
} from "./position"

const NO_USAGE: BudgetUsage = {
  maxConcurrentUserStories: 0,
  maxUserStoryAttempts: 0,
  maxPlanRevisionsPerMilestone: 0,
  maxAgentUserStoriesPerMilestone: 0,
  maxMessagesPerHour: 0,
  maxActiveHours: 0,
  maxPhaseMinutes: 0,
}

function milestone(
  id: string,
  over: Partial<PositionMilestoneInput> = {}
): PositionMilestoneInput {
  return {
    id,
    key: id,
    name: `Milestone ${id}`,
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
function userStory(
  id: string,
  milestoneId = "m1",
  over: Partial<PositionUserStoryInput> = {}
): PositionUserStoryInput {
  return {
    id,
    milestoneId,
    key: id,
    title: `User story ${id}`,
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
    milestoneId: null,
    userStoryId: null,
    status,
    isolated: false,
    createdAt: order,
    ...over,
  }
}

function input(over: Partial<PositionInput> = {}): PositionInput {
  return {
    feature: {
      id: "i1",
      status: "active",
      driveMode: "autopilot",
      hooks: [],
      defaultPodKey: "impl",
    },
    milestones: [milestone("m1", { status: "active" })],
    userStories: [],
    edges: [],
    runs: [],
    mergeQueue: [],
    proposals: [],
    escalations: [],
    workspace: { mode: "git", busy: false },
    pods: [{ key: "impl", builderSeats: 2 }],
    lead: {
      address: "lead@orch",
      rights: ["assign_user_story", "revise_plan", "accept_proof"],
    },
    limits: { maxConcurrentUserStories: 3, maxUserStoryAttempts: 3 },
    budgets: budgetMeters({}, NO_USAGE),
    ...over,
  }
}

const edge = (from: string, to: string, milestoneId = "m1") => ({
  milestoneId,
  fromUserStoryId: from,
  toUserStoryId: to,
})

describe("computePosition — planning", () => {
  it("leaves a due hook to the user outside autopilot", () => {
    const p = computePosition(
      input({
        feature: { ...input().feature, driveMode: "copilot", hooks: ["plan"] },
        milestones: [milestone("m1")],
      })
    )
    expect(p.maneuver.kind).toBe("run_hook")
    expect(p.pendingDecisions).toEqual([
      expect.objectContaining({
        key: "hook_due:plan:",
        kind: "hook_due",
        owner: "user",
      }),
    ])
  })

  it("runs the planning hook when nothing is planned yet", () => {
    const p = computePosition(
      input({
        feature: { ...input().feature, hooks: ["plan"] },
        milestones: [milestone("m1")],
      })
    )
    expect(p.maneuver.kind).toBe("run_hook")
    expect(p.feature.nextHook).toMatchObject({
      hook: "plan",
      milestoneId: null,
    })
  })

  it("waits for the planning proposal, which only the user applies", () => {
    const p = computePosition(
      input({
        feature: { ...input().feature, hooks: ["plan"] },
        milestones: [milestone("m1")],
        runs: [run("plan", "completed")],
        proposals: [
          { id: "p1", kind: "plan", proposer: "lead@orch", summary: "Plan" },
        ],
      })
    )
    expect(p.maneuver.kind).toBe("decide")
    expect(p.pendingDecisions).toEqual([
      expect.objectContaining({
        key: "proposal:p1",
        kind: "plan_proposal",
        owner: "user",
      }),
    ])
  })

  it("asks the user when planning finished without a proposal or failed", () => {
    const done = computePosition(
      input({
        feature: { ...input().feature, hooks: ["plan"] },
        runs: [run("plan", "completed")],
      })
    )
    expect(done.pendingDecisions.map((d) => d.kind)).toEqual(["no_plan"])
    const failed = computePosition(
      input({
        feature: { ...input().feature, hooks: ["plan"] },
        runs: [run("plan", "failed")],
      })
    )
    expect(failed.pendingDecisions.map((d) => d.kind)).toEqual(["hook_failed"])
  })

  it("waits while planning runs", () => {
    const p = computePosition(
      input({
        feature: { ...input().feature, hooks: ["plan"] },
        runs: [run("plan", "running")],
      })
    )
    expect(p.maneuver.kind).toBe("wait")
    expect(p.feature.runningHook?.hook).toBe("plan")
  })
})

describe("computePosition — waves and dispatch", () => {
  it("dispatches the first wave, critical path first, then position", () => {
    // a → c, b independent: critical path a, c. Both a and b are ready.
    const p = computePosition(
      input({
        userStories: [userStory("b"), userStory("a"), userStory("c")],
        edges: [edge("a", "c")],
      })
    )
    expect(p.milestone?.ready).toEqual(["b", "a"])
    expect(p.milestone?.waiting).toEqual([{ userStory: "c", on: ["a"] }])
    expect(p.dispatch.map((d) => d.userStory)).toEqual(["a", "b"])
    expect(p.maneuver.kind).toBe("dispatch")
  })

  it("starts a dependent user story only once its predecessor merged", () => {
    const integrating = computePosition(
      input({
        userStories: [
          userStory("a", "m1", { status: "integrating" }),
          userStory("c"),
        ],
        edges: [edge("a", "c")],
      })
    )
    expect(integrating.dispatch).toEqual([])
    expect(integrating.maneuver.kind).toBe("wait")
    const merged = computePosition(
      input({
        userStories: [userStory("a", "m1", { status: "done" }), userStory("c")],
        edges: [edge("a", "c")],
      })
    )
    expect(merged.dispatch.map((d) => d.userStory)).toEqual(["c"])
  })

  it("respects the concurrency budget and pod capacity", () => {
    const three = [userStory("a"), userStory("b"), userStory("c")]
    const capped = computePosition(
      input({
        userStories: three,
        limits: { maxConcurrentUserStories: 2, maxUserStoryAttempts: 3 },
      })
    )
    expect(capped.dispatch.map((d) => d.userStory)).toEqual(["a", "b"])
    expect(capped.deferred).toEqual([
      {
        userStory: "c",
        reason: expect.stringContaining("2 user stories at once"),
      },
    ])
    const onePod = computePosition(
      input({ userStories: three, pods: [{ key: "impl", builderSeats: 1 }] })
    )
    expect(onePod.dispatch.map((d) => d.userStory)).toEqual(["a"])
    expect(onePod.deferred.map((d) => d.reason)).toEqual([
      "pod impl is busy",
      "pod impl is busy",
    ])
  })

  it("counts user stories already running against capacity", () => {
    const p = computePosition(
      input({
        userStories: [
          userStory("a", "m1", { status: "running" }),
          userStory("b"),
          userStory("c"),
        ],
        runs: [
          run("run", "running", {
            userStoryId: "a",
            milestoneId: "m1",
            isolated: true,
          }),
        ],
        limits: { maxConcurrentUserStories: 2, maxUserStoryAttempts: 3 },
      })
    )
    expect(p.capacity.concurrencyFree).toBe(1)
    expect(p.capacity.podsFree.impl).toBe(1)
    expect(p.dispatch.map((d) => d.userStory)).toEqual(["b"])
  })

  it("serializes user stories with overlapping touch hints", () => {
    const p = computePosition(
      input({
        userStories: [
          userStory("a", "m1", { touchHints: ["src/billing/**"] }),
          userStory("b", "m1", { touchHints: ["src/billing/invoice.ts"] }),
          userStory("c", "m1", { touchHints: ["docs/**"] }),
        ],
      })
    )
    expect(p.dispatch.map((d) => d.userStory)).toEqual(["a", "c"])
    expect(p.deferred).toEqual([
      { userStory: "b", reason: "touch hints overlap a" },
    ])
  })

  it("dispatches overlapping user stories together under the parallel policy", () => {
    const p = computePosition(
      input({
        feature: { ...input().feature, overlapPolicy: "parallel" },
        pods: [{ key: "impl", builderSeats: 3 }],
        userStories: [
          userStory("a", "m1", { touchHints: ["src/billing/**"] }),
          userStory("b", "m1", { touchHints: ["src/billing/invoice.ts"] }),
          userStory("c", "m1", { touchHints: ["docs/**"] }),
        ],
      })
    )
    expect(p.dispatch.map((d) => d.userStory)).toEqual(["a", "b", "c"])
    expect(p.deferred).toEqual([])
  })

  it("runs one at a time in a non-git workspace, and none while it is busy", () => {
    const single = computePosition(
      input({
        userStories: [userStory("a"), userStory("b")],
        workspace: { mode: "single_flight", busy: false },
      })
    )
    expect(single.dispatch.map((d) => d.userStory)).toEqual(["a"])
    const busy = computePosition(
      input({
        userStories: [userStory("a")],
        workspace: { mode: "single_flight", busy: true },
      })
    )
    expect(busy.dispatch).toEqual([])
  })

  it("builds the first user story alone while nothing in the workspace runs yet", () => {
    const greenfield = {
      mode: "git" as const,
      busy: false,
      firstStoryAlone: true,
    }
    const first = computePosition(
      input({
        feature: { ...input().feature, overlapPolicy: "parallel" },
        userStories: [userStory("a"), userStory("b"), userStory("c")],
        workspace: greenfield,
      })
    )
    expect(first.dispatch.map((d) => d.userStory)).toEqual(["a"])
    expect(first.deferred.map((d) => d.reason)).toEqual([
      expect.stringMatching(/first user story builds alone/),
      expect.stringMatching(/first user story builds alone/),
    ])
    const building = computePosition(
      input({
        userStories: [
          userStory("a", "m1", { status: "running" }),
          userStory("b"),
        ],
        runs: [
          run("run", "running", {
            userStoryId: "a",
            milestoneId: "m1",
            isolated: true,
          }),
        ],
        workspace: greenfield,
      })
    )
    expect(building.dispatch).toEqual([])
    expect(building.capacity.concurrencyFree).toBe(0)
  })

  it("holds a user story without acceptance criteria and asks the lead", () => {
    const p = computePosition(
      input({ userStories: [userStory("a", "m1", { acceptanceCount: 0 })] })
    )
    expect(p.dispatch).toEqual([])
    expect(p.milestone?.blocked).toEqual([
      { userStory: "a", reason: "has no acceptance criteria" },
    ])
    expect(p.pendingDecisions[0]).toMatchObject({
      kind: "user_story_unspecified",
      owner: "lead",
    })
  })
})

describe("computePosition — failures and judgment", () => {
  it("retries a user story that stopped without a rejected proof", () => {
    const p = computePosition(
      input({
        userStories: [userStory("a", "m1", { status: "failed", attempts: 1 })],
      })
    )
    expect(p.milestone?.retryable).toEqual(["a"])
    expect(p.dispatch).toEqual([{ userStory: "a", retry: true }])
  })

  it("hands a rejected proof to the lead instead of retrying", () => {
    const p = computePosition(
      input({
        userStories: [
          userStory("a", "m1", {
            status: "failed",
            attempts: 1,
            proofVerdict: "rejected",
          }),
        ],
      })
    )
    expect(p.dispatch).toEqual([])
    expect(p.pendingDecisions).toEqual([
      expect.objectContaining({ key: "proof_rejected:a:1", owner: "lead" }),
    ])
  })

  it("hands repeated failures (soft) and exhausted attempts (hard) to the lead", () => {
    const soft = computePosition(
      input({
        userStories: [userStory("a", "m1", { status: "failed", attempts: 2 })],
      })
    )
    expect(soft.pendingDecisions[0]).toMatchObject({
      key: "user_story_failed:a:2",
      kind: "user_story_failed",
    })
    expect(soft.dispatch).toEqual([])
    const hard = computePosition(
      input({
        userStories: [userStory("a", "m1", { status: "failed", attempts: 3 })],
      })
    )
    expect(hard.pendingDecisions[0].summary).toContain("used all 3 attempts")
  })

  it("puts an approval a running user story waits on in front of the user", () => {
    const p = computePosition(
      input({
        userStories: [userStory("a", "m1", { status: "running" })],
        runApprovals: [
          {
            id: "ap1",
            userStoryId: "a",
            summary: "User story a: test wants to send it back to build.",
          },
        ],
      })
    )
    expect(p.pendingDecisions).toEqual([
      expect.objectContaining({
        key: "run_approval:ap1",
        kind: "run_approval",
        owner: "user",
        target: { kind: "user_story", id: "a" },
      }),
    ])
  })

  it("retries a failed model request past the soft limit and names the cause", () => {
    const lastFailure = {
      reason:
        'Phase "Refine" failed (model request): The model hit the output limit.',
      infrastructure: true,
    }
    const soft = computePosition(
      input({
        userStories: [
          userStory("a", "m1", { status: "failed", attempts: 2, lastFailure }),
        ],
      })
    )
    expect(soft.pendingDecisions).toEqual([])
    expect(soft.dispatch).toEqual([{ userStory: "a", retry: true }])
    const hard = computePosition(
      input({
        userStories: [
          userStory("a", "m1", { status: "failed", attempts: 3, lastFailure }),
        ],
      })
    )
    expect(hard.pendingDecisions[0].summary).toContain(
      'Cause: Phase "Refine" failed (model request)'
    )
    expect(hard.pendingDecisions[0].summary).toContain(
      "splitting or rewriting it won't help"
    )
  })

  it("includes the failure cause when a work failure goes to the lead", () => {
    const p = computePosition(
      input({
        userStories: [
          userStory("a", "m1", {
            status: "failed",
            attempts: 2,
            lastFailure: {
              reason: 'Phase "Build" failed (tool execution): tests failed',
              infrastructure: false,
            },
          }),
        ],
      })
    )
    expect(p.pendingDecisions[0].summary).toContain(
      'Cause: Phase "Build" failed (tool execution)'
    )
    expect(p.dispatch).toEqual([])
  })

  it("sends judgment to the user when the lead lacks the right, or in manual drive", () => {
    const noRight = computePosition(
      input({
        lead: { address: "lead@orch", rights: [] },
        userStories: [
          userStory("a", "m1", {
            status: "failed",
            attempts: 1,
            proofVerdict: "rejected",
          }),
        ],
      })
    )
    expect(noRight.pendingDecisions[0].owner).toBe("user")
    const manual = computePosition(
      input({
        feature: { ...input().feature, driveMode: "manual" },
        userStories: [
          userStory("a", "m1", {
            status: "failed",
            attempts: 1,
            proofVerdict: "rejected",
          }),
        ],
      })
    )
    expect(manual.pendingDecisions[0].owner).toBe("user")
  })

  it("reports user stories blocked by a cancelled dependency", () => {
    const p = computePosition(
      input({
        userStories: [
          userStory("a", "m1", { status: "cancelled" }),
          userStory("b", "m1", { status: "blocked" }),
        ],
        edges: [edge("a", "b")],
      })
    )
    expect(p.milestone?.blocked).toEqual([
      { userStory: "b", reason: "depends on cancelled user story a" },
    ])
    expect(p.pendingDecisions[0]).toMatchObject({
      kind: "user_story_blocked",
      owner: "lead",
    })
  })

  it("surfaces escalated merge conflicts and escalations for the user", () => {
    const p = computePosition(
      input({
        milestones: [
          milestone("m1", {
            status: "integrating",
            integrationBranch: "mc/i/m1/integration",
          }),
        ],
        userStories: [userStory("a", "m1", { status: "integrating" })],
        mergeQueue: [
          {
            id: "q1",
            userStoryId: "a",
            milestoneId: "m1",
            status: "conflict",
            escalated: true,
          },
        ],
        escalations: [{ id: "e1", from: "qa@impl", subject: "Spec is wrong" }],
      })
    )
    expect(p.pendingDecisions.map((d) => [d.kind, d.owner])).toEqual([
      ["escalation", "user"],
      ["merge_conflict", "user"],
    ])
  })
})

describe("computePosition — milestone lifecycle", () => {
  it("runs the milestone's planning review before its first user story", () => {
    const p = computePosition(
      input({
        milestones: [milestone("m1", { hooks: ["before_user_stories"] })],
        userStories: [userStory("a")],
      })
    )
    expect(p.maneuver.kind).toBe("run_hook")
    expect(p.feature.nextHook).toMatchObject({
      hook: "before_user_stories",
      milestoneId: "m1",
    })
    expect(p.dispatch).toEqual([])
    const reviewed = computePosition(
      input({
        milestones: [milestone("m1", { hooks: ["before_user_stories"] })],
        userStories: [userStory("a")],
        runs: [run("before_user_stories", "completed", { milestoneId: "m1" })],
      })
    )
    expect(reviewed.dispatch.map((d) => d.userStory)).toEqual(["a"])
  })

  it("runs the milestone review, then asks the lead to judge the DoD", () => {
    const base = {
      milestones: [
        milestone("m1", {
          status: "review",
          hooks: ["after_all_user_stories" as const],
        }),
      ],
      userStories: [userStory("a", "m1", { status: "done" })],
    }
    expect(computePosition(input(base)).feature.nextHook?.hook).toBe(
      "after_all_user_stories"
    )
    const reviewed = computePosition(
      input({
        ...base,
        runs: [
          run("after_all_user_stories", "completed", { milestoneId: "m1" }),
        ],
      })
    )
    expect(reviewed.pendingDecisions).toEqual([
      expect.objectContaining({ key: "milestone_dod:m1", owner: "lead" }),
    ])
  })

  it("completes a milestone with nothing to land once its DoD is judged", () => {
    const p = computePosition(
      input({
        milestones: [milestone("m1", { status: "review", dodReviewed: true })],
        userStories: [userStory("a", "m1", { status: "done" })],
      })
    )
    expect(p.maneuver).toMatchObject({
      kind: "complete_milestone",
      milestoneId: "m1",
    })
    expect(p.milestone?.doneConditionMet).toBe(true)
  })

  it("waits on the user to land a milestone with an integration branch", () => {
    const p = computePosition(
      input({
        milestones: [
          milestone("m1", {
            status: "review",
            dodReviewed: true,
            integrationBranch: "mc/i/m1/integration",
            mergePolicy: "local_merge",
          }),
        ],
        userStories: [userStory("a", "m1", { status: "done" })],
      })
    )
    expect(p.pendingDecisions).toEqual([
      expect.objectContaining({ kind: "milestone_landing", owner: "user" }),
    ])
    expect(p.pendingDecisions[0].summary).toContain("approve the merge")
  })

  it("runs the release between milestones, then moves to the next milestone", () => {
    const base = {
      feature: { ...input().feature, hooks: ["between_milestones" as const] },
      milestones: [milestone("m1", { status: "completed" }), milestone("m2")],
      userStories: [
        userStory("a", "m1", { status: "done" }),
        userStory("b", "m2"),
      ],
    }
    const release = computePosition(input(base))
    expect(release.feature.activeMilestoneId).toBe("m2")
    expect(release.feature.nextHook).toMatchObject({
      hook: "between_milestones",
      milestoneId: "m1",
    })
    const next = computePosition(
      input({
        ...base,
        runs: [run("between_milestones", "completed", { milestoneId: "m1" })],
      })
    )
    expect(next.dispatch.map((d) => d.userStory)).toEqual(["b"])
  })

  it("completes the feature after the last milestone and its completion hook", () => {
    const base = {
      feature: { ...input().feature, hooks: ["on_complete" as const] },
      milestones: [milestone("m1", { status: "completed" })],
      userStories: [userStory("a", "m1", { status: "done" })],
    }
    expect(computePosition(input(base)).feature.nextHook?.hook).toBe(
      "on_complete"
    )
    const done = computePosition(
      input({ ...base, runs: [run("on_complete", "completed")] })
    )
    expect(done.maneuver.kind).toBe("complete_feature")
    expect(done.feature.complete).toBe(true)
  })

  it("runs the completion hook again after a reopened feature finishes again", () => {
    const base = {
      feature: { ...input().feature, hooks: ["on_complete" as const] },
      milestones: [milestone("m1", { status: "completed", finishedAt: 500 })],
      userStories: [userStory("a", "m1", { status: "done" })],
    }
    const earlier = run("on_complete", "completed", { createdAt: 100 })
    expect(
      computePosition(input({ ...base, runs: [earlier] })).feature.nextHook
        ?.hook
    ).toBe("on_complete")
    const later = run("on_complete", "completed", { createdAt: 600 })
    expect(
      computePosition(input({ ...base, runs: [earlier, later] })).maneuver.kind
    ).toBe("complete_feature")
  })

  it("asks for user stories when the active milestone is empty", () => {
    const p = computePosition(
      input({
        milestones: [milestone("m1", { status: "completed" }), milestone("m2")],
        userStories: [userStory("a", "m1", { status: "done" })],
      })
    )
    expect(p.pendingDecisions[0]).toMatchObject({
      kind: "milestone_empty",
      owner: "lead",
    })
  })
})

describe("computePosition — the wave acceptance gate (plan 110)", () => {
  const gated = (over: Partial<PositionMilestoneInput> = {}) =>
    milestone("m1", {
      status: "integrating",
      hooks: ["after_each_wave" as const],
      ...over,
    })

  it("runs the gate once the milestone is quiescent with merged stories", () => {
    const p = computePosition(
      input({
        milestones: [gated()],
        userStories: [
          userStory("a", "m1", { status: "merged" }),
          userStory("b", "m1", { status: "merged" }),
          userStory("c", "m1", { status: "ready" }),
        ],
        edges: [edge("a", "c")],
      })
    )
    expect(p.maneuver).toMatchObject({
      kind: "run_hook",
      hook: { hook: "after_each_wave", milestoneId: "m1" },
    })
    expect(p.feature.nextHook?.hook).toBe("after_each_wave")
    expect(p.milestone?.merged).toEqual(["a", "b"])
    expect(p.dispatch).toEqual([])
  })

  it("keeps a dependent of a merged story waiting: only done satisfies it", () => {
    const p = computePosition(
      input({
        milestones: [gated()],
        userStories: [
          userStory("a", "m1", { status: "merged" }),
          userStory("c", "m1", { status: "ready" }),
        ],
        edges: [edge("a", "c")],
      })
    )
    expect(p.milestone?.ready).toEqual([])
    expect(p.milestone?.waiting).toEqual([{ userStory: "c", on: ["a"] }])
  })

  it("starts nothing new while the gate is due or running", () => {
    const stories = [
      userStory("a", "m1", { status: "merged" }),
      userStory("b", "m1", { status: "running" }),
      userStory("x", "m1", { status: "ready" }),
    ]
    const due = computePosition(
      input({ milestones: [gated()], userStories: stories })
    )
    expect(due.maneuver.kind).toBe("wait")
    expect(due.dispatch).toEqual([])
    expect(due.deferred).toEqual([
      { userStory: "x", reason: "waiting for the acceptance gate" },
    ])

    const running = computePosition(
      input({
        milestones: [gated()],
        userStories: [
          userStory("a", "m1", { status: "merged" }),
          userStory("x", "m1", { status: "ready" }),
        ],
        runs: [run("after_each_wave", "running", { milestoneId: "m1" })],
        gates: [
          {
            id: "g1",
            milestoneId: "m1",
            round: 1,
            status: "running",
            storyIds: ["a"],
          },
        ],
      })
    )
    expect(running.maneuver).toMatchObject({ kind: "wait" })
    expect(running.maneuver.text).toContain("round 1")
    expect(running.dispatch).toEqual([])
    expect(running.milestone?.gate).toEqual({ round: 1, status: "running" })
  })

  it("asks the user to re-run a gate that failed on the same batch", () => {
    const p = computePosition(
      input({
        milestones: [gated()],
        userStories: [userStory("a", "m1", { status: "merged" })],
        runs: [run("after_each_wave", "failed", { milestoneId: "m1" })],
        gates: [
          {
            id: "g1",
            milestoneId: "m1",
            round: 1,
            status: "failed",
            storyIds: ["a"],
          },
        ],
      })
    )
    expect(p.maneuver.kind).toBe("decide")
    expect(p.pendingDecisions).toEqual([
      expect.objectContaining({
        key: "hook_failed:after_each_wave:g1",
        owner: "user",
        action: {
          kind: "run_hook",
          hook: "after_each_wave",
          milestoneId: "m1",
        },
      }),
    ])
  })

  it("dispatches the next wave once the gate passed", () => {
    const p = computePosition(
      input({
        milestones: [gated({ status: "active" })],
        userStories: [
          userStory("a", "m1", { status: "done" }),
          userStory("c", "m1", { status: "ready" }),
        ],
        edges: [edge("a", "c")],
        gates: [
          {
            id: "g1",
            milestoneId: "m1",
            round: 1,
            status: "passed",
            storyIds: ["a"],
          },
        ],
      })
    )
    expect(p.dispatch.map((d) => d.userStory)).toEqual(["c"])
  })

  it("counts the milestone complete-able only once the last gate passed", () => {
    const merged = computePosition(
      input({
        milestones: [gated({ status: "integrating", dodReviewed: true })],
        userStories: [userStory("a", "m1", { status: "merged" })],
      })
    )
    expect(merged.milestone?.doneConditionMet).toBe(false)
    expect(merged.maneuver.kind).toBe("run_hook")
    const passed = computePosition(
      input({
        milestones: [gated({ status: "review", dodReviewed: true })],
        userStories: [userStory("a", "m1", { status: "done" })],
      })
    )
    expect(passed.maneuver).toMatchObject({ kind: "complete_milestone" })
  })

  it("runs the gate itself in Copilot and leaves it to the user in Manual", () => {
    const base = {
      milestones: [gated()],
      userStories: [userStory("a", "m1", { status: "merged" })],
    }
    const copilot = computePosition(
      input({
        ...base,
        feature: { ...input().feature, driveMode: "copilot" },
      })
    )
    expect(copilot.maneuver.kind).toBe("run_hook")
    expect(copilot.pendingDecisions).toEqual([])
    const manual = computePosition(
      input({ ...base, feature: { ...input().feature, driveMode: "manual" } })
    )
    expect(manual.pendingDecisions).toEqual([
      expect.objectContaining({
        kind: "hook_due",
        key: "hook_due:after_each_wave:m1",
      }),
    ])
  })

  it("fingerprints a story moving from merged to done", () => {
    const base = { milestones: [gated()] }
    const merged = computePosition(
      input({
        ...base,
        userStories: [userStory("a", "m1", { status: "merged" })],
      })
    )
    const done = computePosition(
      input({
        ...base,
        userStories: [userStory("a", "m1", { status: "done" })],
      })
    )
    expect(positionFingerprint(merged)).not.toBe(positionFingerprint(done))
    expect(renderPosition(merged)).toContain(
      "Merged, awaiting the acceptance gate: a"
    )
  })
})

describe("computePosition — budgets and identity", () => {
  it("raises budget decisions at the soft and hard levels", () => {
    const p = computePosition(
      input({
        userStories: [userStory("a")],
        budgets: budgetMeters(
          {},
          { ...NO_USAGE, maxPlanRevisionsPerMilestone: 8, maxActiveHours: 8 }
        ),
      })
    )
    expect(p.pendingDecisions.map((d) => [d.key, d.owner])).toEqual([
      ["budget:maxPlanRevisionsPerMilestone:soft", "lead"],
      ["budget:maxActiveHours:hard", "user"],
    ])
  })

  it("never acts on a finished milestone's final numbers", () => {
    const meters = budgetMeters(
      {},
      { ...NO_USAGE, maxPlanRevisionsPerMilestone: 10 },
      { key: "m1", final: true }
    )
    expect(
      meters.find((m) => m.key === "maxPlanRevisionsPerMilestone")
    ).toMatchObject({
      scope: "m1, final",
      final: true,
      level: "hard",
    })
    expect(meters.find((m) => m.key === "maxMessagesPerHour")?.scope).toBe(
      "last hour"
    )
    const p = computePosition(
      input({ userStories: [userStory("a")], budgets: meters })
    )
    expect(p.pendingDecisions).toEqual([])
  })

  it("gives the user an action for each decision they own", () => {
    const judge = computePosition(
      input({
        lead: { address: "lead@orch", rights: ["assign_user_story"] },
        milestones: [milestone("m1", { status: "review" })],
        userStories: [userStory("a", "m1", { status: "done" })],
      })
    )
    expect(judge.pendingDecisions[0]).toMatchObject({
      kind: "milestone_dod",
      owner: "user",
      action: { kind: "judge_milestone", milestoneId: "m1" },
    })
    const hook = computePosition(
      input({
        milestones: [milestone("m1", { hooks: ["before_user_stories"] })],
        userStories: [userStory("a")],
        runs: [run("before_user_stories", "failed", { milestoneId: "m1" })],
      })
    )
    expect(hook.pendingDecisions[0].action).toEqual({
      kind: "run_hook",
      hook: "before_user_stories",
      milestoneId: "m1",
    })
    const lead = computePosition(
      input({
        userStories: [userStory("a", "m1", { status: "failed", attempts: 3 })],
      })
    )
    expect(lead.pendingDecisions[0]).toMatchObject({ owner: "lead" })
    expect(lead.pendingDecisions[0].action).toBeUndefined()
  })

  it("fingerprints the same state identically and a changed state differently", () => {
    const state = input({ userStories: [userStory("a"), userStory("b")] })
    expect(positionFingerprint(computePosition(state))).toBe(
      positionFingerprint(computePosition(state))
    )
    const moved = {
      ...state,
      userStories: state.userStories.map((s) =>
        s.id === "a" ? { ...s, status: "running" } : s
      ),
    }
    expect(positionFingerprint(computePosition(moved))).not.toBe(
      positionFingerprint(computePosition(state))
    )
  })

  it("renders a position for a seat", () => {
    const text = renderPosition(
      computePosition(
        input({
          userStories: [userStory("a"), userStory("b")],
          edges: [edge("a", "b")],
        })
      )
    )
    expect(text).toContain("Active milestone: m1")
    expect(text).toContain("Waves: 1) a  2) b")
    expect(text).toContain("Next: Start a.")
  })
})
