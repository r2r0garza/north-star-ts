// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  Decision,
  Feature,
  FeatureGraph,
  Finding,
  Position,
  WorkspaceAnalysis,
  Workspace,
} from "@/types"
import { FeatureHome } from "./feature-home"
import { WaitingOnYou, type WaitingItems } from "./proposals-inbox"
import {
  WorkspaceChecklist,
  type WorkspaceAnalysisState,
} from "./workspace-checklist"

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
  }),
}))

let container: HTMLDivElement
let root: Root

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function render(node: React.ReactNode) {
  act(() => root.render(node))
}

const feature = (patch: Partial<Feature> = {}): Feature =>
  ({
    id: "f1",
    key: "shop",
    name: "Shop checkout",
    intent: "Let customers pay with a saved card.",
    definitionOfDone: "",
    rigId: "rig",
    rigSnapshot: null,
    workspaceId: "w1",
    projectId: null,
    defaultPodKey: null,
    playbookId: null,
    driveMode: "autopilot",
    budgets: {},
    drive: {
      autoApplyPlan: true,
      overlapPolicy: "wait",
      activeMs: 0,
      accountedAt: null,
      pauseReason: null,
      pausedBy: null,
      healthMuted: [],
    },
    status: "draft",
    taskId: null,
    createdAt: 0,
    updatedAt: 0,
    startedAt: null,
    finishedAt: null,
    ...patch,
  }) as Feature

const graph = (patch: Partial<Feature> = {}): FeatureGraph => ({
  feature: feature(patch),
  milestones: [],
  userStories: [],
  edges: [],
  revisions: [],
  rigDrifted: false,
})

const workspace = {
  id: "w1",
  path: "/repo",
  name: "repo",
  generatedFiles: [],
  worktreeSetup: { linkPaths: [], steps: [] },
  createdAt: 0,
  updatedAt: 0,
} as Workspace

function finding(patch: Partial<Finding> & Pick<Finding, "key">): Finding {
  return {
    category: "main-environment",
    severity: "blocker",
    title: patch.key,
    explanation: "Because.",
    evidence: [{ id: "e1", kind: "file", label: "requirements.txt exists" }],
    confidence: "verified",
    source: "recipe",
    fix: {
      kind: "run-command",
      summary: "Install",
      commands: [{ label: "Install", command: "uv sync", cwd: "" }],
      verify: [],
    },
    alternatives: [],
    status: "open",
    ...patch,
  }
}

function analysis(
  findings: Finding[],
  patch: Partial<WorkspaceAnalysis> = {}
): WorkspaceAnalysis {
  return {
    featureId: "f1",
    workspaceId: "w1",
    workspacePath: "/repo",
    repoRoot: "/repo",
    subpath: "",
    status: "ready",
    stage: null,
    startedAt: 0,
    analyzedAt: 1,
    fingerprint: "fp",
    analyzerVersion: 1,
    recipeVersion: 1,
    projects: [],
    findings,
    modelStatus: "unavailable",
    modelNote: null,
    rejected: [],
    error: null,
    stale: false,
    ...patch,
  }
}

const state = (a: WorkspaceAnalysis | null): WorkspaceAnalysisState => ({
  analysis: a,
  run: null,
  loading: false,
  reload: async () => {},
  analyze: vi.fn(async () => {}),
})

const noWaiting: WaitingItems = {
  proposals: [],
  resolved: [],
  escalations: [],
  decisions: [],
  count: 0,
  top: null,
  reload: async () => {},
}

let api: Record<string, ReturnType<typeof vi.fn>>
let drive: Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  api = {
    applyFix: vi.fn(async () => ({ analysis: null, run: null })),
    dismiss: vi.fn(async () => null),
    previewApplyAll: vi.fn(async () => []),
    applyAll: vi.fn(async () => ({ analysis: null, run: null })),
    cancelRun: vi.fn(async () => {}),
  }
  drive = {
    start: vi.fn(async () => ({
      graph: graph(),
      planningError: null,
      preflight: { blocked: false, applied: [], blockers: [], review: [] },
    })),
    pause: vi.fn(async () => graph({ status: "paused" })),
  }
  ;(window as unknown as { cowork: unknown }).cowork = {
    missionControl: { analysis: api, drive },
    terminal: { onData: () => () => {}, write: vi.fn(), resize: vi.fn() },
  }
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

const text = () => container.textContent ?? ""
const button = (label: string) =>
  [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label
  ) ??
  [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.trim().startsWith(label)
  ) ??
  null

function home(props: Partial<Parameters<typeof FeatureHome>[0]> = {}) {
  return (
    <FeatureHome
      graph={graph()}
      position={null}
      workspace={workspace}
      analysis={state(null)}
      waiting={noWaiting}
      onGraph={vi.fn()}
      onShowWaiting={vi.fn()}
      onEditDetails={vi.fn()}
      onReviewSetup={vi.fn()}
      {...props}
    />
  )
}

describe("FeatureHome", () => {
  it("opens a draft on name, intent, readiness, and one primary Start — no advanced controls", () => {
    render(home())
    expect(text()).toContain("Shop checkout")
    expect(text()).toContain("Let customers pay with a saved card.")
    expect(text()).toContain("Ready to start")
    expect(button("Start")).not.toBeNull()
    expect(button("Analyze workspace")).not.toBeNull()
    expect(text()).not.toMatch(
      /Overlapping stories|Generated files|Worktree environment|Budgets/
    )
  })

  it("starts with the stored drive choices and reports a blocked preflight", async () => {
    drive.start.mockResolvedValueOnce({
      graph: graph(),
      planningError: null,
      preflight: {
        blocked: true,
        applied: [],
        blockers: ["main-env:.:uv"],
        review: [],
      },
    })
    const blocked = analysis([
      finding({ key: "main-env:.:uv", title: "Python environment missing" }),
    ])
    render(home({ analysis: state(blocked) }))
    expect(text()).toContain("Needs your input")
    await act(async () => button("Start")!.click())
    await flush()
    expect(drive.start).toHaveBeenCalledWith("f1", {
      mode: "autopilot",
      autoApplyPlan: true,
      skipPreflight: false,
      reviewed: false,
    })
    expect(button("Start anyway")).not.toBeNull()
    // The blocker got fixed: Start resumes from preflight.
    render(
      home({
        analysis: state(
          analysis([finding({ key: "main-env:.:uv", status: "resolved" })])
        ),
      })
    )
    expect(button("Continue starting")).not.toBeNull()
  })

  it("pauses Start once for setup that saves commands, then starts as chosen", async () => {
    drive.start.mockResolvedValueOnce({
      graph: graph(),
      planningError: null,
      preflight: {
        blocked: false,
        applied: [],
        blockers: [],
        review: ["generated:churn:.code-index"],
      },
    })
    api.previewApplyAll.mockResolvedValue([
      {
        id: "generated:churn:.code-index",
        findingKey: "generated:churn:.code-index",
        title: "Generated .code-index/ will cause merge conflicts",
        kind: "settings",
        summary: "Regenerate after merging",
        commands: [
          {
            label: "Regenerates .code-index/**",
            command: "make index",
            cwd: "",
          },
        ],
        defaultSelected: true,
        confidence: "likely",
      },
      {
        id: "other",
        findingKey: "other",
        title: "Not part of the review",
        kind: "settings",
        summary: "",
        commands: [],
        defaultSelected: true,
        confidence: "verified",
      },
    ])
    render(home())
    await act(async () => button("Start")!.click())
    await flush()
    const dialog = () => document.body.textContent ?? ""
    expect(dialog()).toContain("Set up the project before starting?")
    expect(dialog()).toContain("make index")
    expect(dialog()).not.toContain("Not part of the review")
    const startWithout = [...document.body.querySelectorAll("button")].find(
      (b) => b.textContent === "Start without them"
    )!
    await act(async () => startWithout.click())
    await flush()
    expect(drive.start).toHaveBeenLastCalledWith(
      "f1",
      expect.objectContaining({ reviewed: true })
    )
  })

  it("after Apply and start, starts only when the setup run succeeds", async () => {
    drive.start.mockResolvedValueOnce({
      graph: graph(),
      planningError: null,
      preflight: {
        blocked: false,
        applied: [],
        blockers: [],
        review: ["main-env:.:npm"],
      },
    })
    api.previewApplyAll.mockResolvedValue([
      {
        id: "main-env:.:npm",
        findingKey: "main-env:.:npm",
        title: "Install",
        kind: "command",
        summary: "npm ci",
        commands: [{ label: "Install", command: "npm ci", cwd: "" }],
        defaultSelected: true,
        confidence: "verified",
      },
    ])
    const running = {
      id: "run1",
      featureId: "f1",
      status: "running" as const,
      startedAt: 0,
      finishedAt: null,
      steps: [],
      note: null,
    }
    api.applyAll.mockResolvedValue({ analysis: null, run: running })
    render(home())
    await act(async () => button("Start")!.click())
    await flush()
    const apply = [...document.body.querySelectorAll("button")].find((b) =>
      b.textContent?.startsWith("Apply and start")
    )!
    await act(async () => apply.click())
    await flush()
    expect(api.applyAll).toHaveBeenCalledWith("f1", ["main-env:.:npm"])
    expect(drive.start).toHaveBeenCalledTimes(1)
    expect(text()).toContain("Setting up, then starting…")
    render(
      home({
        analysis: {
          ...state(null),
          run: { ...running, status: "succeeded", finishedAt: 1 },
        },
      })
    )
    await flush()
    expect(drive.start).toHaveBeenCalledTimes(2)
    expect(drive.start).toHaveBeenLastCalledWith(
      "f1",
      expect.objectContaining({ reviewed: true })
    )
  })

  it("shows the checklist inline once there is an analysis", () => {
    render(
      home({
        analysis: state(
          analysis([
            finding({
              key: "main-env:.:uv",
              title: "Python environment missing",
            }),
          ])
        ),
      })
    )
    expect(text()).toContain("Python environment missing")
    expect(button("Run")).not.toBeNull()
  })

  it("shows current activity and the top waiting item for an active feature", () => {
    const decision: Decision = {
      key: "d1",
      kind: "merge_conflict",
      owner: "user",
      target: { kind: "user_story", id: "s1" },
      summary: "A merge needs your decision",
    }
    const onShowWaiting = vi.fn()
    render(
      home({
        graph: graph({ status: "active" }),
        position: {
          maneuver: { kind: "dispatch", text: "Starting 2 user stories" },
          feature: { activeMilestoneId: null },
        } as unknown as Position,
        waiting: {
          ...noWaiting,
          decisions: [decision],
          count: 2,
          top: { kind: "decision", decision },
        },
        onShowWaiting,
      })
    )
    expect(text()).toContain("Starting 2 user stories")
    expect(text()).toContain("A merge needs your decision")
    expect(button("Pause")).not.toBeNull()
    act(() => button("Resolve (2)")!.click())
    expect(onShowWaiting).toHaveBeenCalled()
  })
})

describe("WorkspaceChecklist", () => {
  it("renders fixes, manual steps, and collapsed groups, and sends only finding keys", async () => {
    const a = analysis([
      finding({ key: "main-env:.:uv", title: "Python environment missing" }),
      finding({
        key: "local-config:.env",
        severity: "warning",
        category: "local-config",
        title: "New worktrees won't have .env",
        fix: {
          kind: "apply-settings",
          summary: "Link .env",
          patch: { worktreeLinkPaths: { add: [".env"] } },
        },
      }),
      finding({
        key: "git-isolation:not-a-repo",
        severity: "warning",
        category: "git-isolation",
        title: "This folder isn't a Git repository",
        fix: { kind: "manual", summary: "Init", steps: ["git init"] },
      }),
      finding({
        key: "build-cost:.",
        severity: "info",
        title: "Builds start from scratch",
        fix: { kind: "manual", summary: "", steps: ["Use sccache"] },
      }),
      finding({
        key: "main-env:web:npm",
        status: "resolved",
        resolution: "Checks passed",
        title: "JavaScript dependencies are ready",
      }),
    ])
    render(<WorkspaceChecklist featureId="f1" state={state(a)} />)
    expect(text()).toContain("uv sync")
    expect(text()).toContain("git init")
    expect(text()).toContain("Already set up (1)")
    expect(text()).not.toContain("JavaScript dependencies are ready")
    expect(button("Apply all…")).not.toBeNull()
    await act(async () => button("Apply")!.click())
    expect(api.applyFix).toHaveBeenCalledWith("f1", "local-config:.env", null)
    await act(async () => button("Run")!.click())
    expect(api.applyFix).toHaveBeenLastCalledWith("f1", "main-env:.:uv", null)
  })

  it("says so plainly when the project couldn't be checked", () => {
    render(
      <WorkspaceChecklist
        featureId="f1"
        state={state(
          analysis([], {
            status: "failed",
            error: "The workspace folder doesn't exist",
          })
        )}
      />
    )
    expect(text()).toContain("Could not check the project")
    expect(text()).toContain("doesn't exist")
  })
})

describe("WaitingOnYou", () => {
  it("renders exactly the items it counts, each focusable, and nothing when empty", () => {
    const decisions: Decision[] = [
      {
        key: "d1",
        kind: "hook_failed",
        owner: "user",
        target: { kind: "feature", id: "f1" },
        summary: "Planning failed",
      },
      {
        key: "d2",
        kind: "budget",
        owner: "user",
        target: { kind: "feature", id: "f1" },
        summary: "Budget reached",
        action: { kind: "edit_budgets" },
      },
    ]
    const navigation = {
      openMilestone: vi.fn(),
      openUserStory: vi.fn(),
      openComms: vi.fn(),
      editBudgets: vi.fn(),
    }
    render(
      <WaitingOnYou
        graph={graph({ status: "active" })}
        waiting={{
          ...noWaiting,
          decisions,
          count: 2,
          top: { kind: "decision", decision: decisions[0] },
        }}
        onGraph={vi.fn()}
        navigation={navigation}
      />
    )
    expect(container.querySelectorAll("[data-waiting-item]").length).toBe(2)
    expect(text()).toContain("Waiting on you2")
    // A decision without an inline action still has a destination.
    expect(text()).toContain("No direct action for this here (hook failed)")
    act(() => button("Open Comms")!.click())
    expect(navigation.openComms).toHaveBeenCalled()
    render(
      <WaitingOnYou
        graph={graph({ status: "active" })}
        waiting={noWaiting}
        onGraph={vi.fn()}
        navigation={navigation}
      />
    )
    expect(container.querySelector("#mission-control-waiting")).toBeNull()
  })
})
