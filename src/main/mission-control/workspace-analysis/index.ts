import { randomUUID } from "crypto"
import { existsSync } from "fs"
import path from "path"
import type { Feature, RigGraph, Workspace } from "../../db/types"
import * as store from "../../db/repositories/workspace-analyses"
import {
  ANALYZER_VERSION,
  CATEGORY_ORDER,
  type ApplyAllItem,
  type CommandSpec,
  type Finding,
  type Fix,
  type ProbeSpec,
  type SetupRunView,
  type WorkspaceAnalysis,
  type WorkspaceSettingsPatch,
  type AppServiceShape,
} from "../../../shared/mission-control/workspace-analysis"
import { stripAnsi } from "../../agent/approval/ansi"
import {
  analyzeWorkspace,
  currentFingerprint,
  type CheckResults,
  type CurrentSettings,
} from "./analyze"
import { APP_LAUNCH_FINDING, appLaunchDraftsAtRef } from "./app-launch"
import { applyPatch, validatePatch } from "./apply"
import { assembleFindings, autoApplicable, evidenceHash } from "./assemble"
import type { FindingDraft } from "./draft"
import { ECOSYSTEM_INFO, languageOf } from "./inventory"
import { interpret, type Complete } from "./interpret"
import { checkSetupCommand } from "./policy"
import { modelRecipe } from "./recipe-model"
import {
  describeServices,
  startServices,
  stopServices,
} from "../app-launch"
import type { AppLaunch } from "../../../shared/mission-control/app-launch"
import { reader } from "./analyze"
import { RECIPE_VERSION } from "./recipes"
import {
  TEST_BROWSER_FINDING,
  testBrowserDraft,
  type WorkspaceBrowser,
} from "./test-browser"
import { toolEnv, warmShellPath } from "./tool-env"
import type { TestBrowserState } from "../playwright-install"
import { QA_ROLE } from "../qa-scope"

// Workspace setup analysis (plan 106.11): one service behind Analyze
// workspace, the checklist's fixes, Apply all, Run checks, and Start's
// preflight. Deterministic stages first; the model refines afterwards and
// never blocks Start. The renderer sends finding keys, never commands: every
// command run or saved here comes from this service's own stored analysis
// and passes command policy again at the moment it's used.

interface TerminalLike {
  runCommand(input: {
    ownerId: string
    cwd: string
    command: string
    title: string
    env?: Record<string, string>
  }): { id: string }
  kill(id: string): void
  on(
    event: "data",
    listener: (e: { id: string; data: string }) => void
  ): unknown
  on(
    event: "exit",
    listener: (e: {
      id: string
      exitCode: number | null
      signal: number | null
    }) => void
  ): unknown
}

export interface WorkspaceAnalysisDeps {
  terminals: TerminalLike
  getFeature(id: string): Feature | undefined
  // The feature's live rig, for a draft that has no rig snapshot yet.
  getRig?(id: string): RigGraph | null
  getWorkspace(id: string): Workspace | undefined
  updateWorkspace(
    id: string,
    patch: Pick<Workspace, "worktreeSetup" | "generatedFiles"> &
      Partial<Pick<Workspace, "appLaunch">>
  ): Workspace
  setOverlapPolicy(featureId: string, value: "wait" | "parallel"): void
  // The model, when a provider is configured; null means unavailable.
  complete(): Complete | null
  onChanged(featureId: string): void
  onRunChanged(run: SetupRunView): void
  // The test browser QA's Playwright checks need (plan 109.06). Absent, no
  // test browser finding is made.
  testBrowser?: TestBrowserDeps
  now?: () => number
}

export interface TestBrowserDeps {
  state(): TestBrowserState
  // Re-detect Chrome and the downloaded browser, without downloading.
  refresh(): Promise<TestBrowserState>
  // Download it (applying the fix is the user's consent).
  install(): Promise<boolean>
  onChanged(listener: (state: TestBrowserState) => void): () => void
  // The workspace's own Playwright and its browser; null when it has none.
  workspace(workspacePath: string): Promise<WorkspaceBrowser | null>
}

interface Pending {
  output: string
  resolve: (result: { exitCode: number | null; output: string }) => void
}

interface InternalRun {
  view: SetupRunView
  commands: Array<{
    step: SetupRunView["steps"][number]
    cwdAbs: string
    probeId?: string
  }>
  cancelled: boolean
  activeSession: string | null
}

const OUTPUT_TAIL = 4000
const MODEL_TIMEOUT_MS = 120_000
// The model plus up to three real starts of the app.
const VERIFY_TIMEOUT_MS = 10 * 60_000
const MODEL_MAX_TOKENS = 4000

export const ownerIdFor = (featureId: string) => `mission-control:${featureId}`

export class WorkspaceAnalysisService {
  private readonly inflight = new Map<string, Promise<WorkspaceAnalysis>>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly running = new Map<string, WorkspaceAnalysis>()
  // An analysis that failed before it could be stored (a database or
  // internal error): shown as "Could not check the project" instead of the
  // checklist silently disappearing.
  private readonly failures = new Map<string, WorkspaceAnalysis>()
  private readonly runs = new Map<string, InternalRun>()
  private readonly pending = new Map<string, Pending>()
  // The workspace's own Playwright and its browser, by workspace path (null:
  // it has none). Probed by analysis and Start; read by the live finding.
  private readonly workspaceBrowsers = new Map<
    string,
    WorkspaceBrowser | null
  >()
  private readonly probing = new Map<string, Promise<void>>()
  // Features whose analysis was read: re-read when the test browser changes.
  private readonly watched = new Set<string>()

  constructor(private readonly deps: WorkspaceAnalysisDeps) {
    deps.testBrowser?.onChanged(() => {
      for (const featureId of this.watched) deps.onChanged(featureId)
    })
    void warmShellPath()
    deps.terminals.on("data", ({ id, data }) => {
      const p = this.pending.get(id)
      if (!p) return
      p.output = (p.output + data).slice(-OUTPUT_TAIL * 2)
    })
    deps.terminals.on("exit", ({ id, exitCode }) => {
      const p = this.pending.get(id)
      if (!p) return
      this.pending.delete(id)
      p.resolve({ exitCode, output: stripAnsi(p.output).slice(-OUTPUT_TAIL) })
    })
  }

  private now() {
    return this.deps.now?.() ?? Date.now()
  }

  // ── reading ───────────────────────────────────────────────────────────────

  private context(featureId: string) {
    const feature = this.deps.getFeature(featureId)
    if (!feature) throw new Error(`Feature not found: ${featureId}`)
    if (!feature.workspaceId)
      throw new Error("Choose a workspace for this feature first.")
    const workspace = this.deps.getWorkspace(feature.workspaceId)
    if (!workspace) throw new Error("The feature's workspace no longer exists.")
    return { feature, workspace }
  }

  private settings(feature: Feature, workspace: Workspace): CurrentSettings {
    return {
      linkPaths: workspace.worktreeSetup.linkPaths,
      steps: workspace.worktreeSetup.steps,
      generatedFiles: workspace.generatedFiles,
      overlapPolicy: feature.drive.overlapPolicy,
      appServices: workspace.appLaunch.services,
    }
  }

  // ── the test browser (plan 109.06) ────────────────────────────────────────

  // Re-detect the test browser and the workspace's own Playwright browser.
  private refreshBrowser(workspacePath: string): Promise<void> {
    const testBrowser = this.deps.testBrowser
    if (!testBrowser) return Promise.resolve()
    const existing = this.probing.get(workspacePath)
    if (existing) return existing
    const probe = (async () => {
      await testBrowser.refresh().catch(() => null)
      const own = await testBrowser.workspace(workspacePath).catch(() => null)
      this.workspaceBrowsers.set(workspacePath, own)
    })().finally(() => this.probing.delete(workspacePath))
    this.probing.set(workspacePath, probe)
    return probe
  }

  // The live test browser finding draft, or null (no QA seat, not probed
  // yet, nothing known).
  private browserDraft(
    feature: Feature,
    workspace: Workspace
  ): FindingDraft | null {
    const testBrowser = this.deps.testBrowser
    if (!testBrowser) return null
    // A draft has no rig snapshot yet (Start takes it): use the live rig.
    const rig =
      feature.rigSnapshot ??
      (feature.rigId ? (this.deps.getRig?.(feature.rigId) ?? null) : null)
    const qaSeat = !!rig?.seats.some((s) => s.role === QA_ROLE)
    if (qaSeat && !this.workspaceBrowsers.has(workspace.path)) {
      // First read since the app started: probe, then re-read.
      if (!this.probing.has(workspace.path))
        void this.refreshBrowser(workspace.path).then(() =>
          this.deps.onChanged(feature.id)
        )
      return null
    }
    return testBrowserDraft({
      qaSeat,
      workspace: this.workspaceBrowsers.get(workspace.path),
      bundled: testBrowser.state(),
    })
  }

  // The current analysis, resolved against the current settings. Null when
  // there is none for the feature's current workspace (changing the
  // workspace invalidates it).
  get(featureId: string): WorkspaceAnalysis | null {
    const feature = this.deps.getFeature(featureId)
    if (!feature?.workspaceId) return null
    const running = this.running.get(featureId)
    const live = running?.workspaceId === feature.workspaceId ? running : null
    let stored = store.getStoredAnalysis(featureId)
    if (stored && stored.analysis.workspaceId !== feature.workspaceId) {
      store.deleteStoredAnalysis(featureId)
      stored = null
    }
    const workspace = this.deps.getWorkspace(feature.workspaceId)
    const failure = this.failures.get(featureId)
    if (!live && failure?.workspaceId === feature.workspaceId) return failure
    if (!stored || !workspace) return live
    this.watched.add(featureId)
    const browser = this.browserDraft(feature, workspace)
    const findings = assembleFindings({
      drafts: [
        ...(stored.drafts as FindingDraft[]).filter(
          (d) => d.key !== TEST_BROWSER_FINDING
        ),
        ...(browser ? [browser] : []),
      ],
      settings: this.settings(feature, workspace),
      dismissals: stored.dismissals,
    }).map((f) =>
      stored.lastRuns[f.key] ? { ...f, lastRun: stored.lastRuns[f.key] } : f
    )
    const analysis: WorkspaceAnalysis = { ...stored.analysis, findings }
    return live
      ? { ...analysis, status: "running", stage: live.stage }
      : analysis
  }

  // Has the workspace changed since the analysis (manifests, lockfiles,
  // ignored environments)? Marks the stored result stale.
  async checkFreshness(featureId: string): Promise<WorkspaceAnalysis | null> {
    const analysis = this.get(featureId)
    if (!analysis || analysis.status !== "ready" || !analysis.fingerprint)
      return analysis
    const current = await currentFingerprint(analysis.workspacePath).catch(
      () => null
    )
    const stale = current !== analysis.fingerprint
    if (stale !== analysis.stale) {
      const stored = store.getStoredAnalysis(featureId)
      if (stored) {
        store.saveStoredAnalysis(featureId, {
          ...stored,
          analysis: { ...stored.analysis, stale },
        })
        this.deps.onChanged(featureId)
      }
    }
    return this.get(featureId)
  }

  // The app launch finding for a branch's tip (plan 109.07): a milestone's
  // earlier stories may have built the app on its integration branch, which
  // the checkout this analysis reads doesn't have yet. A detected recipe
  // joins the stored checklist so it can be applied there; null when nothing
  // runnable was found.
  async appLaunchAtRef(
    featureId: string,
    ref: string,
    options: { record?: boolean } = {}
  ): Promise<Finding | null> {
    const { feature, workspace } = this.context(featureId)
    const draft = (
      await appLaunchDraftsAtRef({ workspace: workspace.path, ref })
    ).find((d) => d.key === APP_LAUNCH_FINDING)
    if (!draft) return null
    const settings = this.settings(feature, workspace)
    const stored = store.getStoredAnalysis(featureId)
    const current = stored?.analysis.workspaceId === workspace.id
    // Looking only (`record: false`), or nothing stored to add it to.
    if (options.record === false || !stored || !current)
      return (
        assembleFindings({
          drafts: [draft],
          settings,
          dismissals: current ? stored!.dismissals : {},
        })[0] ?? null
      )
    const drafts = [
      ...(stored.drafts as FindingDraft[]).filter(
        (d) => d.key !== APP_LAUNCH_FINDING
      ),
      draft,
    ]
    store.saveStoredAnalysis(featureId, {
      ...stored,
      drafts,
      analysis: {
        ...stored.analysis,
        findings: assembleFindings({
          drafts,
          settings,
          dismissals: stored.dismissals,
        }),
      },
    })
    this.deps.onChanged(featureId)
    return (
      this.get(featureId)?.findings.find((f) => f.key === APP_LAUNCH_FINDING) ??
      null
    )
  }

  // ── analyzing ─────────────────────────────────────────────────────────────

  // Concurrent calls for a feature share one run.
  analyze(
    featureId: string,
    // verifyRecipe: start the written app launch recipe in the workspace
    // before keeping it (Start does, once the environment is set up).
    options: { model?: boolean; verifyRecipe?: boolean } = {}
  ): Promise<WorkspaceAnalysis> {
    const existing = this.inflight.get(featureId)
    if (existing) return existing
    this.failures.delete(featureId)
    const promise = this.runAnalysis(
      featureId,
      options.model !== false,
      options.verifyRecipe === true
    )
      .catch((error: unknown) => {
        const started = this.running.get(featureId)
        const failed: WorkspaceAnalysis | null = started
          ? {
              ...started,
              status: "failed",
              stage: null,
              analyzedAt: this.now(),
              modelStatus: "skipped",
              error: error instanceof Error ? error.message : String(error),
            }
          : null
        if (failed) this.failures.set(featureId, failed)
        throw error
      })
      .finally(() => {
        this.inflight.delete(featureId)
        this.controllers.delete(featureId)
        this.running.delete(featureId)
        this.deps.onChanged(featureId)
      })
    this.inflight.set(featureId, promise)
    return promise
  }

  cancel(featureId: string): void {
    this.controllers.get(featureId)?.abort()
  }

  private async runAnalysis(
    featureId: string,
    useModel: boolean,
    verifyRecipe = false
  ): Promise<WorkspaceAnalysis> {
    const { feature, workspace } = this.context(featureId)
    if (!existsSync(workspace.path))
      throw new Error(`The workspace folder doesn't exist: ${workspace.path}`)
    const controller = new AbortController()
    this.controllers.set(featureId, controller)
    const previous = store.getStoredAnalysis(featureId)
    const sameWorkspace = previous?.analysis.workspaceId === workspace.id
    const base: WorkspaceAnalysis = {
      featureId,
      workspaceId: workspace.id,
      workspacePath: workspace.path,
      repoRoot: null,
      subpath: "",
      status: "running",
      stage: "Starting",
      startedAt: this.now(),
      analyzedAt: null,
      fingerprint: null,
      analyzerVersion: ANALYZER_VERSION,
      recipeVersion: RECIPE_VERSION,
      projects: [],
      findings: sameWorkspace ? (this.get(featureId)?.findings ?? []) : [],
      modelStatus: "pending",
      modelNote: null,
      rejected: [],
      error: null,
      stale: false,
    }
    this.running.set(featureId, base)
    this.deps.onChanged(featureId)
    const settings = this.settings(feature, workspace)
    let facts: Awaited<ReturnType<typeof analyzeWorkspace>>
    try {
      facts = await analyzeWorkspace({
        workspace: workspace.path,
        settings,
        checkResults: sameWorkspace ? previous!.checkResults : {},
        signal: controller.signal,
        onStage: (stage) => {
          this.running.set(featureId, {
            ...this.running.get(featureId)!,
            stage,
          })
          this.deps.onChanged(featureId)
        },
      })
    } catch (error) {
      const failed: WorkspaceAnalysis = {
        ...base,
        status: "failed",
        stage: null,
        analyzedAt: this.now(),
        error: error instanceof Error ? error.message : String(error),
        modelStatus: "skipped",
      }
      this.save(
        featureId,
        failed,
        sameWorkspace ? (previous!.drafts as FindingDraft[]) : [],
        previous,
        sameWorkspace
      )
      return failed
    }
    // The feature may have switched workspace meanwhile: discard.
    if (this.deps.getFeature(featureId)?.workspaceId !== workspace.id)
      throw new Error("The feature's workspace changed during analysis.")
    await this.refreshBrowser(workspace.path)

    // Model findings from the last run carry over when the model isn't asked
    // again (re-analysis after a fix).
    // The model's app launch recipe outranks the rules' guess at it.
    const carried =
      !useModel && sameWorkspace
        ? (previous!.drafts as FindingDraft[]).filter(
            (d) =>
              d.source === "model" &&
              (d.key === APP_LAUNCH_FINDING ||
                !facts.drafts.some((x) => x.key === d.key))
          )
        : []
    let drafts = [
      ...facts.drafts.filter((d) => !carried.some((c) => c.key === d.key)),
      ...carried,
    ]
    const complete = useModel ? this.deps.complete() : null
    const analysis: WorkspaceAnalysis = {
      ...base,
      repoRoot: facts.git.root,
      subpath: facts.git.subpath,
      status: "ready",
      stage: null,
      analyzedAt: this.now(),
      fingerprint: facts.fingerprint,
      projects: facts.inventory.roots.map((r) => ({
        root: r.dir,
        ecosystems: r.ecosystems.map((id) => ({
          id,
          language: languageOf(r, id),
          manager: ECOSYSTEM_INFO[id].manager,
        })),
      })),
      modelStatus: complete
        ? "running"
        : useModel
          ? "unavailable"
          : sameWorkspace
            ? previous!.analysis.modelStatus
            : "skipped",
      modelNote: complete
        ? null
        : useModel
          ? "No model provider is configured, so only the built-in checks ran."
          : sameWorkspace
            ? previous!.analysis.modelNote
            : null,
      rejected: !useModel && sameWorkspace ? previous!.analysis.rejected : [],
    }
    this.save(featureId, analysis, drafts, previous, sameWorkspace)
    this.running.delete(featureId)
    this.deps.onChanged(featureId)
    if (!complete) return this.get(featureId)!

    // Stage 7: the model, bounded in time; failure keeps the checklist.
    // The app launch recipe is its own call beside it: a workspace without a
    // recipe gets one written for whatever stack it is (or, with no app yet,
    // planned from the intent), so nobody stops to set it up.
    // A recipe is only started once nothing blocks the workspace: a missing
    // environment would fail it for reasons the recipe can't fix.
    const verify =
      verifyRecipe &&
      !(this.get(featureId)?.findings ?? []).some(
        (f) => f.status === "open" && f.severity === "blocker"
      )
    const timer = setTimeout(
      () => controller.abort(),
      verify ? VERIFY_TIMEOUT_MS : MODEL_TIMEOUT_MS
    )
    const recipe = workspace.appLaunch.services.length
      ? null
      : modelRecipe({
          workspace: workspace.path,
          files: facts.files,
          roots: facts.inventory.roots,
          intent: `${feature.name}. ${feature.intent}`,
          setupSteps: plannedSetupSteps(drafts),
          hint: ruleRecipe(drafts),
          read: reader(workspace.path),
          complete,
          signal: controller.signal,
          ...(verify
            ? {
                tryStart: (candidate: AppLaunch) =>
                  trialStart(featureId, workspace.path, candidate, controller.signal),
              }
            : {}),
        }).catch((error: unknown) => {
          console.warn("[workspace-analysis] app launch recipe:", error)
          return null
        })
    try {
      const result = await interpret({
        facts,
        drafts,
        intent: `${feature.name}. ${feature.intent}`,
        workspace: workspace.path,
        complete,
        signal: controller.signal,
      })
      const written = await recipe
      if (written?.draft)
        drafts = [
          ...drafts.filter((d) => d.key !== APP_LAUNCH_FINDING),
          written.draft,
        ]
      // The model saw more to start than the rules did, but its recipe
      // didn't pass the checks: the rules' guess stays, saying what it may
      // be missing, rather than passing for the whole app.
      else if (written?.proposed?.length)
        drafts = drafts.map((d) =>
          d.key === APP_LAUNCH_FINDING
            ? {
                ...d,
                confidence: "guess",
                explanation: `${d.explanation} The model found more to start (${written.proposed!.join(", ")}), but its recipe didn't pass the checks (${written.rejected[0]?.reason ?? "unknown"}), so this one may not start all of it. The first builder completes it with app_launch_save.`,
              }
            : d
        )
      if (written?.rejected.length) result.rejected.push(...written.rejected)
      drafts = drafts.map((d) => {
        const paired = result.generatedCommands.find((g) => g.key === d.key)
        const explained = result.explanations[d.key]
        let next = d
        if (paired && d.fix.kind === "manual") {
          const group = facts.generated.find((g) => g.key === d.key)
          next = {
            ...next,
            confidence: "likely",
            source: "model",
            explanation: `${group?.paths.join(", ") ?? "These files"} look generated. Regenerate them with \`${paired.command}\` after merging instead of merging by hand (suggested from the project's docs and scripts).`,
            evidence: [
              ...next.evidence,
              { kind: "doc", label: paired.evidence },
            ],
            fix: {
              kind: "apply-settings",
              summary: `Regenerate with \`${paired.command}\` after merging`,
              patch: {
                generatedFiles: {
                  add: [{ paths: group?.paths ?? [], command: paired.command }],
                },
              },
            },
          }
        }
        if (explained) next = { ...next, explanation: explained }
        return next
      })
      drafts.push(
        ...result.drafts.filter((d) => !drafts.some((x) => x.key === d.key))
      )
      if (result.rejected.length)
        console.warn(
          `[workspace-analysis] rejected ${result.rejected.length} model findings:`,
          result.rejected
        )
      const latest = store.getStoredAnalysis(featureId)
      this.save(
        featureId,
        {
          ...(latest?.analysis ?? analysis),
          modelStatus: "used",
          modelNote: null,
          rejected: result.rejected,
        },
        drafts,
        latest,
        true
      )
    } catch (error) {
      const message = controller.signal.aborted
        ? "The model took too long; the built-in checks are shown."
        : `The model couldn't be used (${error instanceof Error ? error.message.slice(0, 200) : String(error)}); the built-in checks are shown.`
      const latest = store.getStoredAnalysis(featureId)
      if (latest?.analysis.workspaceId === workspace.id)
        this.save(
          featureId,
          { ...latest.analysis, modelStatus: "failed", modelNote: message },
          latest.drafts as FindingDraft[],
          latest,
          true
        )
    } finally {
      clearTimeout(timer)
    }
    return this.get(featureId)!
  }

  private save(
    featureId: string,
    analysis: WorkspaceAnalysis,
    drafts: FindingDraft[],
    previous: store.StoredAnalysis | null,
    keepUserState: boolean
  ) {
    const { feature, workspace } = this.context(featureId)
    const findings = assembleFindings({
      drafts,
      settings: this.settings(feature, workspace),
      dismissals: keepUserState ? (previous?.dismissals ?? {}) : {},
    })
    store.saveStoredAnalysis(featureId, {
      analysis: { ...analysis, findings },
      drafts,
      lastRuns: keepUserState ? (previous?.lastRuns ?? {}) : {},
      dismissals: keepUserState ? (previous?.dismissals ?? {}) : {},
      checkResults: keepUserState ? (previous?.checkResults ?? {}) : {},
      approvals: keepUserState ? (previous?.approvals ?? []) : [],
    })
  }

  // ── dismissing ────────────────────────────────────────────────────────────

  dismiss(
    featureId: string,
    key: string,
    dismissed = true
  ): WorkspaceAnalysis | null {
    const stored = store.getStoredAnalysis(featureId)
    if (!stored) throw new Error("Analyze the workspace first.")
    const { feature, workspace } = this.context(featureId)
    const draft =
      key === TEST_BROWSER_FINDING
        ? this.browserDraft(feature, workspace)
        : (stored.drafts as FindingDraft[]).find((d) => d.key === key)
    if (!draft) throw new Error("That finding is no longer current.")
    const dismissals = { ...stored.dismissals }
    if (dismissed) dismissals[key] = evidenceHash(draft)
    else delete dismissals[key]
    store.saveStoredAnalysis(featureId, { ...stored, dismissals })
    this.deps.onChanged(featureId)
    return this.get(featureId)
  }

  // ── applying ──────────────────────────────────────────────────────────────

  private finding(featureId: string, key: string): Finding {
    const analysis = this.get(featureId)
    if (!analysis || analysis.status === "running")
      throw new Error("The analysis is still running.")
    const finding = analysis.findings.find((f) => f.key === key)
    if (!finding)
      throw new Error("That finding is no longer current. Analyze again.")
    return finding
  }

  private applySettings(
    featureId: string,
    patch: WorkspaceSettingsPatch,
    findingKey: string
  ) {
    const { workspace } = this.context(featureId)
    const invalid = validatePatch(patch, workspace.path)
    if (invalid) throw new Error(`This fix can't be applied: ${invalid}`)
    if (
      patch.worktreeLinkPaths?.add?.length ||
      patch.worktreeLinkPaths?.remove?.length ||
      patch.worktreeSetupSteps?.add?.length ||
      patch.worktreeSetupSteps?.remove?.length ||
      patch.generatedFiles?.add?.length ||
      patch.appLaunch?.add?.length
    ) {
      const next = applyPatch(
        {
          worktreeSetup: workspace.worktreeSetup,
          generatedFiles: workspace.generatedFiles,
          appLaunch: workspace.appLaunch,
        },
        patch,
        findingKey
      )
      this.deps.updateWorkspace(workspace.id, next)
      this.recordApprovals(featureId, findingKey, [
        ...(patch.worktreeSetupSteps?.add ?? []).map((s) => ({
          command: s.command,
          cwd: s.cwd,
        })),
        ...(patch.generatedFiles?.add ?? []).map((r) => ({
          command: r.command,
          cwd: "",
        })),
        ...(patch.appLaunch?.add ?? []).map((service) => ({
          command: service.command,
          cwd: service.cwd,
        })),
      ])
    }
    if (patch.overlapPolicy)
      this.deps.setOverlapPolicy(featureId, patch.overlapPolicy)
  }

  private recordApprovals(
    featureId: string,
    findingKey: string,
    commands: Array<{ command: string; cwd: string }>
  ) {
    if (!commands.length) return
    const stored = store.getStoredAnalysis(featureId)
    if (!stored) return
    store.saveStoredAnalysis(featureId, {
      ...stored,
      approvals: [
        ...stored.approvals,
        ...commands.map((c) => ({
          ...c,
          findingKey,
          fingerprint: stored.analysis.fingerprint,
          at: this.now(),
        })),
      ],
    })
  }

  private fixOf(finding: Finding, alternative?: number | null): Fix {
    if (alternative === undefined || alternative === null) return finding.fix
    const fix = finding.alternatives[alternative]
    if (!fix) throw new Error("That option is no longer available.")
    return fix
  }

  // Apply one finding's fix (or one of its alternatives). Settings apply at
  // once; commands and checks start a run in the integrated terminal.
  async applyFix(
    featureId: string,
    key: string,
    alternative?: number | null
  ): Promise<{ analysis: WorkspaceAnalysis | null; run: SetupRunView | null }> {
    const finding = this.finding(featureId, key)
    const fix = this.fixOf(finding, alternative)
    if (fix.kind === "manual")
      throw new Error("This one is done by hand; follow its steps.")
    if (fix.kind === "download-test-browser") {
      this.downloadTestBrowser()
      return { analysis: this.get(featureId), run: null }
    }
    if (fix.kind === "apply-settings") {
      this.applySettings(featureId, fix.patch, key)
      this.deps.onChanged(featureId)
      return { analysis: this.get(featureId), run: null }
    }
    if (this.activeRun(featureId))
      throw new Error("A setup run is already in progress.")
    if (fix.kind === "run-command" && fix.patch)
      this.applySettings(featureId, fix.patch, key)
    const run = this.startRun(featureId, [{ finding, fix }])
    return { analysis: this.get(featureId), run }
  }

  // The download runs in the background; its progress and the finding's
  // resolution arrive through the test browser's change events.
  private downloadTestBrowser() {
    const testBrowser = this.deps.testBrowser
    if (!testBrowser) throw new Error("The test browser isn't available here.")
    void testBrowser
      .install()
      .catch((error) =>
        console.warn(
          "[workspace-analysis] test browser download failed:",
          error
        )
      )
  }

  // The review sheet for Apply all: every open fix, in execution order.
  previewApplyAll(featureId: string): ApplyAllItem[] {
    const analysis = this.get(featureId)
    if (!analysis || analysis.status !== "ready") return []
    const order = (f: Finding) => CATEGORY_ORDER.indexOf(f.category)
    return analysis.findings
      .filter((f) => f.status === "open" && f.fix.kind !== "manual")
      .sort((a, b) => order(a) - order(b))
      .map((f): ApplyAllItem => {
        const fix = f.fix
        const commands: CommandSpec[] =
          fix.kind === "run-command"
            ? fix.commands
            : fix.kind === "run-checks"
              ? fix.probes.map((p) => ({
                  label: p.label,
                  command: p.command ?? "",
                  cwd: p.cwd,
                }))
              : fix.kind === "apply-settings"
                ? [
                    ...(fix.patch.worktreeSetupSteps?.add ?? []).map((s) => ({
                      label: `Saved as a worktree setup step: ${s.label}`,
                      command: s.command,
                      cwd: s.cwd,
                    })),
                    ...(fix.patch.generatedFiles?.add ?? []).map((r) => ({
                      label: `Saved as the regeneration command for ${r.paths.join(", ")}`,
                      command: r.command,
                      cwd: "",
                    })),
                    ...(fix.patch.appLaunch?.add ?? []).map((service) => ({
                      label: `Saved as the app launch service ${service.label}`,
                      command: service.command,
                      cwd: service.cwd,
                    })),
                  ]
                : []
        return {
          id: f.key,
          findingKey: f.key,
          title: f.title,
          kind:
            fix.kind === "apply-settings"
              ? "settings"
              : fix.kind === "run-checks"
                ? "check"
                : fix.kind === "download-test-browser"
                  ? "download"
                  : "command",
          summary: fix.summary,
          commands,
          defaultSelected: f.confidence !== "guess" && !f.replacesUserSetting,
          confidence: f.confidence,
        }
      })
  }

  // Apply the selected items: settings first (in order), then one run with
  // every command and check, in order, stopping at the first failure.
  async applyAll(
    featureId: string,
    selected: string[]
  ): Promise<{ analysis: WorkspaceAnalysis | null; run: SetupRunView | null }> {
    if (this.activeRun(featureId))
      throw new Error("A setup run is already in progress.")
    const chosen = new Set(selected)
    const items = this.previewApplyAll(featureId).filter((i) =>
      chosen.has(i.id)
    )
    const toRun: Array<{ finding: Finding; fix: Fix }> = []
    for (const item of items) {
      const finding = this.finding(featureId, item.findingKey)
      if (finding.fix.kind === "apply-settings")
        this.applySettings(featureId, finding.fix.patch, finding.key)
      else if (finding.fix.kind === "download-test-browser")
        this.downloadTestBrowser()
      else {
        if (finding.fix.kind === "run-command" && finding.fix.patch)
          this.applySettings(featureId, finding.fix.patch, finding.key)
        toRun.push({ finding, fix: finding.fix })
      }
    }
    this.deps.onChanged(featureId)
    const run = toRun.length ? this.startRun(featureId, toRun) : null
    if (!run) void this.analyze(featureId, { model: false }).catch(() => {})
    return { analysis: this.get(featureId), run }
  }

  // ── runs ──────────────────────────────────────────────────────────────────

  activeRun(featureId: string): SetupRunView | null {
    for (const run of this.runs.values())
      if (run.view.featureId === featureId && run.view.status === "running")
        return run.view
    return null
  }

  getRun(featureId: string): SetupRunView | null {
    const all = [...this.runs.values()].filter(
      (r) => r.view.featureId === featureId
    )
    return all.at(-1)?.view ?? null
  }

  cancelRun(runId: string): void {
    const run = this.runs.get(runId)
    if (!run || run.view.status !== "running") return
    run.cancelled = true
    if (run.activeSession) this.deps.terminals.kill(run.activeSession)
  }

  private startRun(
    featureId: string,
    items: Array<{ finding: Finding; fix: Fix }>
  ): SetupRunView {
    const { workspace } = this.context(featureId)
    const commands: InternalRun["commands"] = []
    for (const { finding, fix } of items) {
      const specs: Array<CommandSpec & { probe?: ProbeSpec }> =
        fix.kind === "run-command"
          ? fix.commands
          : fix.kind === "run-checks"
            ? fix.probes
                .filter((p) => p.command)
                .map((p) => ({
                  label: p.label,
                  command: p.command!,
                  cwd: p.cwd,
                  probe: p,
                }))
            : []
      for (const spec of specs) {
        const cwdAbs = path.resolve(workspace.path, spec.cwd)
        const rel = path.relative(workspace.path, cwdAbs)
        if (rel.startsWith("..") || path.isAbsolute(rel))
          throw new Error(
            `${spec.label}: its directory is outside the workspace.`
          )
        // Recipe probes may set an environment variable or chain a quiet
        // check; they're ours, not the model's. Fix commands must pass policy.
        if (!spec.probe) {
          const verdict = checkSetupCommand(spec.command, cwdAbs)
          if (!verdict.ok)
            throw new Error(`\`${spec.command}\` can't run: ${verdict.reason}`)
        }
        commands.push({
          cwdAbs,
          ...(spec.probe ? { probeId: spec.probe.id } : {}),
          step: {
            label: spec.label,
            command: spec.command,
            cwd: spec.cwd,
            kind: spec.probe ? "probe" : "fix",
            findingKey: finding.key,
            status: "pending",
            exitCode: null,
            sessionId: null,
          },
        })
      }
    }
    if (!commands.length) throw new Error("Nothing to run.")
    const view: SetupRunView = {
      id: randomUUID(),
      featureId,
      status: "running",
      startedAt: this.now(),
      finishedAt: null,
      steps: commands.map((c) => c.step),
      note: null,
    }
    const run: InternalRun = {
      view,
      commands,
      cancelled: false,
      activeSession: null,
    }
    this.runs.set(view.id, run)
    // Keep the last few runs per feature.
    const mine = [...this.runs.values()].filter(
      (r) => r.view.featureId === featureId
    )
    for (const old of mine.slice(0, -5)) this.runs.delete(old.view.id)
    this.recordApprovals(
      featureId,
      "run",
      commands.map((c) => ({ command: c.step.command, cwd: c.step.cwd }))
    )
    void this.execute(run)
    this.emitRun(run)
    return view
  }

  private emitRun(run: InternalRun) {
    run.view = { ...run.view, steps: run.commands.map((c) => ({ ...c.step })) }
    this.deps.onRunChanged(run.view)
  }

  private async execute(run: InternalRun): Promise<void> {
    const featureId = run.view.featureId
    await warmShellPath()
    const env = toolEnv()
    // The user is watching and can answer a prompt: no CI mode here.
    delete env.CI
    delete env.GIT_TERMINAL_PROMPT
    const outcomes = new Map<
      string,
      { ok: boolean; exitCode: number | null; output: string; note: string }
    >()
    let failed = false
    for (const item of run.commands) {
      if (failed || run.cancelled) {
        item.step.status = "skipped"
        continue
      }
      item.step.status = "running"
      let session: { id: string }
      try {
        session = this.deps.terminals.runCommand({
          ownerId: ownerIdFor(featureId),
          cwd: item.cwdAbs,
          command: item.step.command,
          title: item.step.label,
          env,
        })
      } catch (error) {
        item.step.status = "failed"
        failed = true
        outcomes.set(item.step.findingKey ?? "", {
          ok: false,
          exitCode: null,
          output: "",
          note: error instanceof Error ? error.message : String(error),
        })
        this.emitRun(run)
        continue
      }
      item.step.sessionId = session.id
      run.activeSession = session.id
      this.emitRun(run)
      const result = await new Promise<{
        exitCode: number | null
        output: string
      }>((resolve) => this.pending.set(session.id, { output: "", resolve }))
      run.activeSession = null
      item.step.exitCode = result.exitCode
      const ok = result.exitCode === 0 && !run.cancelled
      item.step.status = ok ? "ok" : "failed"
      if (item.probeId)
        this.recordCheck(featureId, item.probeId, ok, result.output)
      const key = item.step.findingKey ?? ""
      const prior = outcomes.get(key)
      outcomes.set(key, {
        ok: (prior?.ok ?? true) && ok,
        exitCode: result.exitCode,
        output: result.output,
        note: ok
          ? ""
          : run.cancelled
            ? "Cancelled"
            : `\`${item.step.command}\` exited with ${result.exitCode ?? "a signal"}`,
      })
      if (!ok && item.step.kind === "fix") failed = true
      this.emitRun(run)
    }
    // Re-check: a finding counts as fixed only when analysis says so.
    let analysis: WorkspaceAnalysis | null = null
    try {
      analysis = await this.analyze(featureId, { model: false })
    } catch (error) {
      run.view.note = `Re-checking failed: ${error instanceof Error ? error.message : String(error)}`
    }
    const unresolved: string[] = []
    const stored = store.getStoredAnalysis(featureId)
    if (stored) {
      const lastRuns = { ...stored.lastRuns }
      for (const [key, outcome] of outcomes) {
        if (!key) continue
        const after = analysis?.findings.find((f) => f.key === key)
        const verified = outcome.ok && (!after || after.status !== "open")
        if (outcome.ok && !verified) unresolved.push(after?.title ?? key)
        lastRuns[key] = {
          at: this.now(),
          ok: verified,
          exitCode: outcome.exitCode,
          note: !outcome.ok
            ? outcome.note
            : verified
              ? "Done, and the check now passes"
              : "The command finished, but the check still doesn't pass",
          outputTail: outcome.output.slice(-1500),
        }
      }
      store.saveStoredAnalysis(featureId, { ...stored, lastRuns })
    }
    run.view.status = run.cancelled
      ? "cancelled"
      : failed
        ? "failed"
        : "succeeded"
    run.view.finishedAt = this.now()
    if (!run.view.note)
      run.view.note = run.cancelled
        ? "Cancelled."
        : failed
          ? "Stopped at the first failure. Fix it (the output is in the terminal) and try again."
          : unresolved.length
            ? `Ran everything, but ${unresolved.length} check${unresolved.length === 1 ? " still fails" : "s still fail"}: ${unresolved.slice(0, 3).join("; ")}.`
            : "Done. Everything that ran is verified."
    this.emitRun(run)
    this.deps.onChanged(featureId)
  }

  private recordCheck(
    featureId: string,
    probeId: string,
    ok: boolean,
    output: string
  ) {
    const stored = store.getStoredAnalysis(featureId)
    if (!stored?.analysis.fingerprint) return
    const checkResults: CheckResults = {
      ...stored.checkResults,
      [probeId]: {
        ok,
        detail: output.trim().split("\n").slice(-3).join(" ").slice(0, 300),
        at: this.now(),
        fingerprint: stored.analysis.fingerprint,
      },
    }
    store.saveStoredAnalysis(featureId, { ...stored, checkResults })
  }

  // ── Start preflight ───────────────────────────────────────────────────────

  // Before a draft feature starts: reuse a fresh analysis or run one (built-in
  // checks only), apply what's safe to apply without asking, and report what
  // still needs the user. The one exception to "the model never delays
  // Start": a workspace without an app launch recipe waits for the model to
  // write one (once per workspace), and it's applied without asking, so
  // planning and every seat know how the app starts.
  async preflight(featureId: string): Promise<{
    ok: boolean
    analysis: WorkspaceAnalysis | null
    applied: string[]
    blockers: string[]
    // Open warnings whose fix saves a command (setup steps, regeneration
    // rules) or runs one: Start asks once before going without them.
    review: string[]
  }> {
    const feature = this.deps.getFeature(featureId)
    if (!feature?.workspaceId)
      return { ok: true, analysis: null, applied: [], blockers: [], review: [] }
    let analysis = this.inflight.has(featureId)
      ? await this.inflight.get(featureId)!
      : await this.checkFreshness(featureId)
    if (!analysis || analysis.status !== "ready" || analysis.stale)
      analysis = await this.analyze(featureId, { model: false })
    if (analysis.status !== "ready")
      return {
        ok: false,
        analysis,
        applied: [],
        blockers: ["analysis-failed"],
        review: [],
      }
    const needsRecipe = () =>
      !this.context(featureId).workspace.appLaunch.services.length
    // Stepped: the environment first (its blockers stop Start), then the
    // recipe, written and started for real before it's saved.
    const blocked = analysis.findings.some(
      (f) => f.status === "open" && f.severity === "blocker"
    )
    if (needsRecipe() && !blocked && this.deps.complete()) {
      const withModel = await this.analyze(featureId, {
        model: true,
        verifyRecipe: true,
      }).catch(() => null)
      if (withModel?.status === "ready") analysis = withModel
    }
    const applied: string[] = []
    const recipe = analysis.findings.find(
      (f) => f.key === APP_LAUNCH_FINDING && f.status === "open"
    )
    if (
      needsRecipe() &&
      recipe?.fix.kind === "apply-settings" &&
      !recipe.replacesUserSetting
    ) {
      try {
        this.applySettings(featureId, recipe.fix.patch, recipe.key)
        applied.push(recipe.title)
      } catch (error) {
        console.warn("[workspace-analysis] app launch recipe:", error)
      }
    }
    for (const finding of autoApplicable(analysis.findings)) {
      if (finding.fix.kind !== "apply-settings") continue
      try {
        this.applySettings(featureId, finding.fix.patch, finding.key)
        applied.push(finding.title)
      } catch (error) {
        console.warn("[workspace-analysis] auto-apply failed:", error)
      }
    }
    if (applied.length) this.deps.onChanged(featureId)
    // The test browser is the machine's, not the workspace's: check it now.
    await this.refreshBrowser(analysis.workspacePath)
    analysis = this.get(featureId)
    const open = (analysis?.findings ?? []).filter((f) => f.status === "open")
    const blockers = open
      .filter((f) => f.severity === "blocker")
      .map((f) => f.key)
    const review = open
      .filter((f) => f.severity === "warning" && savesOrRunsCommand(f.fix))
      .map((f) => f.key)
    return { ok: blockers.length === 0, analysis, applied, blockers, review }
  }
}

// A fix that saves a command for later (a worktree setup step, a
// regeneration rule) or runs one now.
function savesOrRunsCommand(fix: Fix): boolean {
  if (fix.kind === "run-command") return true
  if (fix.kind !== "apply-settings") return false
  return (
    !!fix.patch.worktreeSetupSteps?.add?.length ||
    !!fix.patch.generatedFiles?.add?.length ||
    !!fix.patch.appLaunch?.add?.length
  )
}

// What the rule-based detection proposed, as a hint for the recipe model.
function ruleRecipe(drafts: FindingDraft[]): AppServiceShape[] {
  const fix = drafts.find((d) => d.key === APP_LAUNCH_FINDING)?.fix
  return fix?.kind === "apply-settings" ? (fix.patch.appLaunch?.add ?? []) : []
}

// The worktree setup the analysis plans (installs, builds), which runs
// before the app starts, so the recipe doesn't repeat it.
function plannedSetupSteps(drafts: FindingDraft[]): string[] {
  return drafts.flatMap((d) =>
    (d.fix.kind === "apply-settings" || d.fix.kind === "run-command") && d.fix.patch
      ? (d.fix.patch.worktreeSetupSteps?.add ?? []).map(
          (step) => `${step.label}: \`${step.command}\`${step.cwd ? ` in ${step.cwd}` : ""}`
        )
      : []
  )
}

// Start a candidate recipe in the workspace (its environment is set up), then
// stop it: null when every service came up, or what failed, with the
// services' output for the model.
async function trialStart(
  featureId: string,
  root: string,
  recipe: AppLaunch,
  signal: AbortSignal
): Promise<string | null> {
  const owner = `recipe-check:${featureId}`
  try {
    const outcome = await startServices({ owner, root, recipe, signal })
    return outcome.ok
      ? null
      : `${outcome.message}\n${describeServices(outcome.services)}`
  } finally {
    await stopServices({ owner, root })
  }
}
