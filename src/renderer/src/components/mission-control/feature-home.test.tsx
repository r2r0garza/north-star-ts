// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { toast } from "sonner"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  Decision,
  Feature,
  FeatureGraph,
  Finding,
  Position,
  SetupRunView,
  WorkspaceAnalysis,
  Workspace,
} from "@/types"
import { FeatureHome } from "./feature-home"
import {
  focusFirstWaiting,
  WaitingOnYou,
  type WaitingItems,
} from "./proposals-inbox"
import {
  SetupRunPanel,
  useWorkspaceAnalysis,
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
    get: vi.fn(async () => null),
    run: vi.fn(async () => null),
    checkFreshness: vi.fn(async () => null),
    analyze: vi.fn(async () => null),
    onChanged: vi.fn(() => () => {}),
    onRunChanged: vi.fn(() => () => {}),
  }
  drive = {
    start: vi.fn(async () => ({
      graph: graph(),
      planningError: null,
      preflight: { blocked: false, applied: [], blockers: [], review: [] },
    })),
    pause: vi.fn(async () => graph({ status: "paused" })),
    resume: vi.fn(async () => graph({ status: "active" })),
    reopen: vi.fn(async () => graph({ status: "active" })),
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

const setupRun = (patch: Partial<SetupRunView> = {}): SetupRunView => ({
  id: "run1",
  featureId: "f1",
  status: "running",
  startedAt: 0,
  finishedAt: null,
  steps: [],
  note: null,
  ...patch,
})

const step = (
  patch: Partial<SetupRunView["steps"][number]>
): SetupRunView["steps"][number] => ({
  label: "Install",
  command: "uv sync",
  cwd: "",
  kind: "fix",
  findingKey: null,
  status: "pending",
  exitCode: null,
  // No session: the xterm view needs a real canvas.
  sessionId: null,
  ...patch,
})

const dialogButton = (label: string) =>
  [...document.body.querySelectorAll("button")].find((b) =>
    b.textContent?.trim().startsWith(label)
  ) ?? null

describe("FeatureHome states", () => {
  it("shows why a feature paused and resumes it", async () => {
    const onGraph = vi.fn()
    render(
      home({
        graph: graph({
          status: "paused",
          drive: {
            ...feature().drive,
            pauseReason: "Budget reached.",
          },
        }),
        onGraph,
      })
    )
    expect(text()).toContain("Budget reached.")
    expect(text()).toContain("nothing new starts until you resume")
    expect(button("Start")).toBeNull()
    await act(async () => button("Resume")!.click())
    await flush()
    expect(drive.resume).toHaveBeenCalledWith("f1")
    expect(onGraph).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: expect.objectContaining({ status: "active" }),
      })
    )
  })

  it("summarizes a completed feature and offers Reopen, not Cancel", async () => {
    render(home({ graph: graph({ status: "completed" }) }))
    expect(text()).toContain("Completed")
    expect(text()).toContain("0 milestones · 0 user stories done.")
    expect(button("Cancel feature")).toBeNull()
    await act(async () => button("Reopen")!.click())
    expect(drive.reopen).toHaveBeenCalledWith("f1")
  })

  it("explains a failed or cancelled feature without offering to run it", () => {
    render(home({ graph: graph({ status: "failed" }) }))
    expect(text()).toContain("See Health and Comms for what happened")
    expect(button("Cancel feature")).toBeNull()
    expect(button("Start")).toBeNull()
    render(home({ graph: graph({ status: "cancelled" }) }))
    expect(text()).toContain("branches and worktrees stay until you delete it")
  })

  it("doesn't start after Apply and start when the setup run fails", async () => {
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
    api.applyAll.mockResolvedValue({ analysis: null, run: setupRun() })
    render(home())
    await act(async () => button("Start")!.click())
    await flush()
    await act(async () => dialogButton("Apply and start")!.click())
    await flush()
    render(
      home({
        analysis: {
          ...state(null),
          run: setupRun({ status: "failed", finishedAt: 1 }),
        },
      })
    )
    await flush()
    expect(drive.start).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining("the feature didn't start")
    )
    expect(button("Start")).not.toBeNull()
  })
})

describe("useWorkspaceAnalysis", () => {
  function Probe({ workspaceId }: { workspaceId: string | null }) {
    const s = useWorkspaceAnalysis("f1", workspaceId)
    return (
      <div>
        {s.loading
          ? "loading"
          : s.analysis
            ? `analysis:${s.analysis.workspaceId}`
            : "none"}
      </div>
    )
  }

  it("never analyzes on its own, and drops the result when the workspace changes", async () => {
    api.get.mockResolvedValueOnce(analysis([]))
    render(<Probe workspaceId="w1" />)
    await flush()
    expect(text()).toBe("analysis:w1")
    // The next read finds nothing: main forgot it with the old workspace.
    api.get.mockResolvedValueOnce(null)
    render(<Probe workspaceId="w2" />)
    expect(text()).toBe("loading")
    await flush()
    expect(text()).toBe("none")
    expect(api.get).toHaveBeenCalledTimes(2)
    expect(api.analyze).not.toHaveBeenCalled()
  })

  it("re-reads when main marks the result stale, ignoring other features", async () => {
    let changed: (featureId: string) => void = () => {}
    api.onChanged.mockImplementation((cb: (featureId: string) => void) => {
      changed = cb
      return () => {}
    })
    api.get.mockResolvedValue(analysis([]))
    let seen: WorkspaceAnalysis | null = null
    function Stale() {
      seen = useWorkspaceAnalysis("f1", "w1").analysis
      return null
    }
    render(<Stale />)
    await flush()
    expect(seen!.stale).toBe(false)
    expect(api.checkFreshness).toHaveBeenCalledWith("f1")
    // checkFreshness saved stale: true and notified.
    api.get.mockResolvedValue(analysis([], { stale: true }))
    await act(async () => changed("f2"))
    await flush()
    expect(seen!.stale).toBe(false)
    await act(async () => changed("f1"))
    await flush()
    expect(seen!.stale).toBe(true)
  })
})

describe("WorkspaceChecklist actions", () => {
  it("marks a stale result and re-analyzes on request", async () => {
    const s = state(
      analysis([finding({ key: "main-env:.:uv" })], { stale: true })
    )
    render(<WorkspaceChecklist featureId="f1" state={s} />)
    expect(text()).toContain("The project changed since this check")
    await act(async () => button("Analyze again")!.click())
    expect(s.analyze).toHaveBeenCalled()
  })

  it("shows a failed attempt with its exit note, and the output under Why?", () => {
    render(
      <WorkspaceChecklist
        featureId="f1"
        state={state(
          analysis([
            finding({
              key: "main-env:.:uv",
              lastRun: {
                at: 1,
                ok: false,
                exitCode: 2,
                note: "uv sync exited with 2",
                outputTail: "error: No interpreter found for Python 3.12",
              },
            }),
          ])
        )}
      />
    )
    expect(text()).toContain("Last attempt: uv sync exited with 2")
    expect(text()).not.toContain("No interpreter found")
    act(() => button("Why?")!.click())
    expect(text()).toContain("No interpreter found for Python 3.12")
    // Still open: the fix is offered again.
    expect(button("Run")).not.toBeNull()
  })

  it("keeps a finding open when the command ran but the check still fails", () => {
    render(
      <WorkspaceChecklist
        featureId="f1"
        state={state(
          analysis([
            finding({
              key: "main-env:.:uv",
              title: "Python environment is broken",
              lastRun: {
                at: 1,
                ok: false,
                exitCode: 0,
                note: "The command finished, but the check still doesn't pass",
                outputTail: "",
              },
            }),
          ])
        )}
      />
    )
    expect(text()).toContain("Python environment is broken")
    expect(text()).toContain(
      "Last attempt: The command finished, but the check still doesn't pass"
    )
    expect(text()).not.toContain("Already set up")
  })

  it("offers Run checks with the exact build-script commands", async () => {
    render(
      <WorkspaceChecklist
        featureId="f1"
        state={state(
          analysis([
            finding({
              key: "main-env:.:maven",
              severity: "info",
              confidence: "likely",
              title:
                "Can't confirm the Java dependencies without running the project's build scripts",
              fix: {
                kind: "run-checks",
                summary: "Run `./mvnw -B -q -o validate`",
                probes: [
                  {
                    id: "maven-validate",
                    label: "Maven validates offline",
                    cwd: "",
                    class: "executes-project-code",
                    command: "./mvnw -B -q -o validate",
                  },
                ],
              },
            }),
          ])
        )}
      />
    )
    expect(text()).toContain("Likely")
    expect(text()).toContain("./mvnw -B -q -o validate")
    await act(async () => button("Run checks")!.click())
    // Only the key goes to main; it owns the command.
    expect(api.applyFix).toHaveBeenCalledWith("f1", "main-env:.:maven", null)
  })

  it("dismisses an open finding and restores a dismissed one", async () => {
    render(
      <WorkspaceChecklist
        featureId="f1"
        state={state(
          analysis([
            finding({ key: "local-config:.env", severity: "warning" }),
            finding({ key: "worktree-env:.venv", status: "dismissed" }),
          ])
        )}
      />
    )
    expect(text()).toContain("Dismissed (1)")
    expect(text()).not.toContain("worktree-env:.venv")
    await act(async () => button("Dismiss")!.click())
    expect(api.dismiss).toHaveBeenCalledWith("f1", "local-config:.env", true)
    act(() => button("Dismissed")!.click())
    expect(text()).toContain("worktree-env:.venv")
    await act(async () => button("Restore")!.click())
    expect(api.dismiss).toHaveBeenLastCalledWith(
      "f1",
      "worktree-env:.venv",
      false
    )
  })

  it("runs only the items left checked in Apply all, guesses unchecked", async () => {
    api.previewApplyAll.mockResolvedValue([
      {
        id: "main-env:.:uv",
        findingKey: "main-env:.:uv",
        title: "Install Python dependencies",
        kind: "command",
        summary: "uv sync",
        commands: [{ label: "Install", command: "uv sync", cwd: "" }],
        defaultSelected: true,
        confidence: "verified",
      },
      {
        id: "local-config:.env",
        findingKey: "local-config:.env",
        title: "Link .env",
        kind: "settings",
        summary: "Link .env into worktrees",
        commands: [],
        defaultSelected: true,
        confidence: "verified",
      },
      {
        id: "generated:docs",
        findingKey: "generated:docs",
        title: "Regenerate docs",
        kind: "settings",
        summary: "make docs",
        commands: [{ label: "Regenerate", command: "make docs", cwd: "" }],
        defaultSelected: false,
        confidence: "guess",
      },
    ])
    render(
      <WorkspaceChecklist
        featureId="f1"
        state={state(analysis([finding({ key: "main-env:.:uv" })]))}
      />
    )
    await act(async () => button("Apply all…")!.click())
    await flush()
    const box = (name: string) =>
      document.body.querySelector<HTMLButtonElement>(
        `[role="checkbox"][aria-label="${name}"]`
      )!
    expect(box("Install Python dependencies").dataset.state).toBe("checked")
    expect(box("Regenerate docs").dataset.state).toBe("unchecked")
    expect(document.body.textContent).toContain("Guess")
    await act(async () => box("Link .env").click())
    expect(dialogButton("Run selected (1)")).not.toBeNull()
    await act(async () => dialogButton("Run selected")!.click())
    await flush()
    expect(api.applyAll).toHaveBeenCalledWith("f1", ["main-env:.:uv"])
  })

  it("shows where Apply all stopped mid-batch, and what didn't run", () => {
    render(
      <SetupRunPanel
        run={setupRun({
          status: "failed",
          finishedAt: 1,
          note: "Stopped at the first failure. Fix it (the output is in the terminal) and try again.",
          steps: [
            step({ label: "Install API", status: "ok", exitCode: 0 }),
            step({
              label: "Install web",
              command: "pnpm install --frozen-lockfile",
              cwd: "web",
              status: "failed",
              exitCode: 1,
            }),
            step({ label: "Generate client", command: "pnpm gen:api" }),
          ],
        })}
      />
    )
    expect(text()).toContain("Setup stopped")
    expect(text()).toContain("exit 1")
    expect(text()).toContain("Stopped at the first failure")
    expect(text()).toContain("Generate client")
    expect(button("Stop")).toBeNull()
  })

  it("lets the user stop a running setup", async () => {
    render(
      <SetupRunPanel run={setupRun({ steps: [step({ status: "running" })] })} />
    )
    expect(text()).toContain("Setting up your project…")
    await act(async () => button("Stop")!.click())
    expect(api.cancelRun).toHaveBeenCalledWith("run1")
  })
})

describe("keyboard focus and narrow layouts", () => {
  it("moves keyboard focus to the first waiting item", () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    expect(focusFirstWaiting()).toBe(false)
    const decision: Decision = {
      key: "d1",
      kind: "budget",
      owner: "user",
      target: { kind: "feature", id: "f1" },
      summary: "Budget reached",
      action: { kind: "edit_budgets" },
    }
    render(
      <WaitingOnYou
        graph={graph({ status: "active" })}
        waiting={{
          ...noWaiting,
          decisions: [decision],
          count: 1,
          top: { kind: "decision", decision },
        }}
        onGraph={vi.fn()}
        navigation={{
          openMilestone: vi.fn(),
          openUserStory: vi.fn(),
          openComms: vi.fn(),
          editBudgets: vi.fn(),
        }}
      />
    )
    expect(focusFirstWaiting()).toBe(true)
    const first = container.querySelector("[data-waiting-item]")
    expect(document.activeElement).toBe(first)
    expect(scroll).toHaveBeenCalled()
  })

  it("exposes expandable sections to assistive tech", () => {
    render(
      <WorkspaceChecklist
        featureId="f1"
        state={state(
          analysis([
            finding({ key: "main-env:.:uv" }),
            finding({ key: "main-env:web:npm", status: "resolved" }),
          ])
        )}
      />
    )
    const why = button("Why?")!
    expect(why.getAttribute("aria-expanded")).toBe("false")
    act(() => why.click())
    expect(why.getAttribute("aria-expanded")).toBe("true")
    const resolved = button("Already set up")!
    expect(resolved.getAttribute("aria-expanded")).toBe("false")
  })

  // happy-dom doesn't lay out, so this pins the classes that make a narrow
  // window wrap instead of overflowing: action rows wrap, long commands break.
  it("wraps action rows and breaks long commands", () => {
    const long = `uv pip install ${"some-very-long-package-name ".repeat(8)}`
    render(
      home({
        analysis: state(
          analysis([
            finding({
              key: "main-env:.:uv",
              fix: {
                kind: "run-command",
                summary: "Install",
                commands: [{ label: "Install", command: long, cwd: "" }],
                verify: [],
              },
            }),
          ])
        ),
      })
    )
    const code = [...container.querySelectorAll("code")].find(
      (c) => c.textContent === long
    )!
    expect(code.className).toMatch(/break-all/)
    expect(code.className).toMatch(/min-w-0/)
    const startRow = button("Start")!.parentElement!
    expect(startRow.className).toMatch(/flex-wrap/)
    const titleRow = container.querySelector("li [class*='flex-wrap']")
    expect(titleRow).not.toBeNull()
  })
})
