import { randomUUID } from "crypto"
import { existsSync } from "fs"
import * as features from "../db/repositories/features"
import * as recipeStates from "../db/repositories/app-recipe-states"
import { recordEvent } from "../db/repositories/mc-events"
import { getWorkspace, updateWorkspace } from "../db/repositories/workspaces"
import type { Feature, Milestone } from "../db/types"
import type { AppLaunch } from "../../shared/mission-control/app-launch"
import {
  failureKey,
  initialRecipeState,
  questionFor,
  type AppRecipeChoiceEffect,
  type AppRecipeFailureRecord,
  type AppRecipeQuestion,
  type AppRecipeState,
} from "../../shared/mission-control/app-recipe"
import {
  verifyRecipe,
  type LaunchFailure,
  type SmokeBrowserLoad,
  type VerifyResult,
} from "./app-launch"
import { classifyRunFailure } from "./run-failure"
import { git } from "./workspace-analysis/exec"
import { detectAppLaunchAtRef } from "./workspace-analysis/app-launch"

// Self-verifying recipes and repair (plan 112.3). The recipe isn't something
// the user reviews: detectors draft it, builders complete it, and this
// service verifies it by running it. A failure is classified; an environment
// failure goes to recipe repair (a builder seat with a recipe-only
// objective, bounded), and what repair can't fix becomes one plain-language
// question with concrete choices. None of it counts against a story's
// attempts or proof revisions.

export const DEFAULT_REPAIR_ATTEMPTS = 3
// The state key of a workspace that isn't a Git checkout.
export const NO_BRANCH = "(workspace)"

export interface RepairTurnInput {
  featureId: string
  userStoryId: string | null
  // Where the repair runs (the story's worktree, or the workspace).
  root: string
  // The main checkout, for {env:KEY} references.
  mainRoot: string
  // Owns what the turn starts with app_start/app_launch_save.
  owner: string
  objective: string
  signal?: AbortSignal
}

// One repair attempt: a builder seat's `work` turn in a fresh conversation.
// Injected, so tests use a fake seat.
export type RepairTurn = (input: RepairTurnInput) => Promise<void>

export interface AppRecipeDeps {
  repairTurn: RepairTurn | null
  browserLoad?: SmokeBrowserLoad | null
  // Post the question to the user through Comms (an escalation that always
  // reaches them). Returns the message id, or null when it couldn't.
  escalate?: (input: {
    featureId: string
    userStoryId: string | null
    body: string
  }) => string | null
  // The question was answered: its escalation is dealt with.
  acknowledge?: (messageId: string) => void
  // The user chose to stop trying: a story waiting on the app ends
  // unverified.
  // End a story unverified: the app couldn't be made to run for it.
  markUnverified?: (userStoryId: string, summary: string) => void
  onSkipped?: (
    question: AppRecipeQuestion,
    failure: AppRecipeFailureRecord | null
  ) => void
  // A question answered and the app checked again (112.4 resumes the
  // story's app check from here).
  onSettled?: (question: AppRecipeQuestion, outcome: EnsureOutcome) => void
  onChanged?: (featureId: string) => void
}

export interface VerifyTarget {
  featureId: string
  workspaceId: string
  root: string
  mainRoot: string
  // Default: read from `root`.
  branch?: string
  commit?: string | null
  signal?: AbortSignal
  // Told each verification's outcome (the app check's receipt, plan 112.4).
  onVerify?: (outcome: VerifyOutcome) => void
}

export interface VerifyOutcome {
  ok: boolean
  // Already verified at this commit: nothing ran.
  cached: boolean
  state: AppRecipeState
  failure: AppRecipeFailureRecord | null
  result: VerifyResult | null
}

export type EnsureOutcome =
  | {
      ok: true
      state: AppRecipeState
      repairs: number
      // The failure repair fixed, when it took a repair.
      repairedFrom?: AppRecipeFailureRecord | null
    }
  | {
      ok: false
      // No recipe at all: nothing to verify (a project with no app, or a
      // greenfield one before its skeleton).
      noRecipe: boolean
      state: AppRecipeState
      failure: AppRecipeFailureRecord | null
      repairs: number
      // Pending with the user, when repair gave up.
      question: AppRecipeQuestion | null
    }

// What a question needs to run again after it's answered.
interface QuestionContext {
  target: Omit<VerifyTarget, "signal" | "onVerify">
  userStoryId: string | null
}

async function headOf(
  root: string
): Promise<{ branch: string; commit: string | null }> {
  const branch = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])
  if (!branch.ok) return { branch: NO_BRANCH, commit: null }
  const commit = await git(root, ["rev-parse", "HEAD"])
  return {
    branch: branch.stdout.trim() || NO_BRANCH,
    commit: commit.ok ? commit.stdout.trim() : null,
  }
}

function toRecord(failure: LaunchFailure): AppRecipeFailureRecord {
  const classified = classifyRunFailure({
    launch: failure,
    smokeVerified: false,
  })
  return {
    stage: failure.stage,
    class: classified.class,
    reason: failure.reason,
    summary: failure.summary,
    logs: failure.logs,
    ...(failure.service ? { service: failure.service } : {}),
    ...(failure.prerequisite ? { prerequisite: failure.prerequisite } : {}),
    ...(failure.missingEnv?.length ? { missingEnv: failure.missingEnv } : {}),
  }
}

export class AppRecipeService {
  private readonly inflight = new Map<string, Promise<VerifyOutcome>>()
  private readonly checking = new Set<string>()
  // Questions' run context, by question id. In memory: after a restart an
  // answer re-checks the workspace's main checkout.
  private readonly contexts = new Map<string, QuestionContext>()
  // App checks waiting on the user's answer, by question id.
  private readonly waiters = new Map<
    string,
    (outcome: EnsureOutcome | { skipped: true }) => void
  >()

  constructor(private readonly deps: AppRecipeDeps) {}

  // An app check gave up (the user skipped): its story ends unverified.
  endUnverified(userStoryId: string, summary: string): void {
    this.deps.markUnverified?.(userStoryId, summary)
  }

  // The smoke stage's browser load, for app_launch_save's verification.
  get browserLoad(): SmokeBrowserLoad | null {
    return this.deps.browserLoad ?? null
  }

  // app_launch_save verified a recipe in `root` and saved it: that branch is
  // verified at its commit (the save marked every branch unverified).
  async recordVerified(input: {
    featureId: string
    workspaceId: string
    root: string
  }): Promise<void> {
    const head = await headOf(input.root)
    const before = this.state(input.workspaceId, head.branch)
    if (before.question?.messageId)
      this.deps.acknowledge?.(before.question.messageId)
    recipeStates.saveRecipeState({
      ...before,
      state: "verified",
      commit: head.commit,
      failure: null,
      question: null,
    })
    this.changed(input.featureId)
  }

  private changed(featureId: string) {
    this.deps.onChanged?.(featureId)
  }

  recipe(workspaceId: string): AppLaunch {
    return getWorkspace(workspaceId)?.appLaunch ?? { services: [] }
  }

  // Repair can only change a recipe a seat may replace: one the user wrote
  // is theirs, so its failure goes straight to the question.
  private repairable(workspaceId: string): boolean {
    return !this.recipe(workspaceId).services.some((s) => s.source === "user")
  }

  // The recorded state for a branch, or the initial one.
  state(workspaceId: string, branch: string): AppRecipeState {
    return (
      recipeStates.getRecipeState(workspaceId, branch) ??
      initialRecipeState(
        workspaceId,
        branch,
        this.recipe(workspaceId).services.length > 0
      )
    )
  }

  // The state of the workspace's main checkout, for the analysis panel.
  async checkoutState(featureId: string): Promise<{
    state: AppRecipeState
    checking: boolean
    // The feature's work isn't in the checkout yet: its integration branch.
    notInCheckout: string | null
  } | null> {
    const feature = features.getFeature(featureId)
    const workspace = feature?.workspaceId
      ? getWorkspace(feature.workspaceId)
      : null
    if (!feature || !workspace) return null
    const { branch } = await headOf(workspace.path)
    const state = this.state(workspace.id, branch)
    return {
      // A recipe written since the row was recorded makes it unverified.
      state:
        !this.recipe(workspace.id).services.length && state.state !== "absent"
          ? { ...state, state: "absent" }
          : state,
      checking: this.checking.has(`${workspace.id}\0${branch}`),
      notInCheckout: await this.workNotInCheckout(featureId, workspace.path),
    }
  }

  // The integration branch of one of the feature's milestones that has work
  // the checkout doesn't (not landed yet, or landed but not pulled), or null.
  // The app the stories built isn't there to check until it lands: checking
  // (and repairing) the checkout before then judges the recipe against code
  // that doesn't have the app.
  async workNotInCheckout(
    featureId: string,
    root: string
  ): Promise<string | null> {
    for (const milestone of features.listMilestones(featureId)) {
      const branch = milestone.integrationBranch
      if (!branch || milestone.status === "cancelled") continue
      const ahead = await git(root, [
        "rev-list",
        "--count",
        `HEAD..refs/heads/${branch}`,
      ])
      if (ahead.ok && Number(ahead.stdout.trim()) > 0) return branch
    }
    return null
  }

  // Verify the recipe by running it, and record the state. Skipped when the
  // branch is already verified at this commit (nothing run-relevant changed
  // means nothing to prove again). One verification per branch at a time.
  async verify(target: VerifyTarget): Promise<VerifyOutcome> {
    const head =
      target.branch !== undefined
        ? { branch: target.branch, commit: target.commit ?? null }
        : await headOf(target.root)
    const key = `${target.workspaceId}\0${head.branch}`
    let run = this.inflight.get(key)
    if (!run) {
      run = this.runVerify(target, head).finally(() => {
        this.inflight.delete(key)
        this.checking.delete(key)
        this.changed(target.featureId)
      })
      this.inflight.set(key, run)
      this.checking.add(key)
      this.changed(target.featureId)
    }
    const { onVerify } = target
    return onVerify
      ? run.then((outcome) => {
          onVerify(outcome)
          return outcome
        })
      : run
  }

  private async runVerify(
    target: VerifyTarget,
    head: { branch: string; commit: string | null }
  ): Promise<VerifyOutcome> {
    const recipe = this.recipe(target.workspaceId)
    const before = this.state(target.workspaceId, head.branch)
    if (!recipe.services.length) {
      const state = recipeStates.saveRecipeState({
        ...before,
        state: "absent",
        commit: null,
        failure: null,
      })
      return { ok: false, cached: false, state, failure: null, result: null }
    }
    if (
      before.state === "verified" &&
      head.commit &&
      before.commit === head.commit
    )
      return {
        ok: true,
        cached: true,
        state: before,
        failure: null,
        result: null,
      }
    const result = await verifyRecipe({
      root: target.root,
      recipe,
      owner: `recipe-verify:${target.workspaceId}:${head.branch}`,
      mainRoot: target.mainRoot,
      signal: target.signal,
      browserLoad: this.deps.browserLoad ?? null,
    })
    // The recipe changed while it ran (a builder saved one): this result
    // says nothing about the new one.
    const now = this.recipe(target.workspaceId)
    if (JSON.stringify(now) !== JSON.stringify(recipe)) {
      const state = this.state(target.workspaceId, head.branch)
      return { ok: false, cached: false, state, failure: null, result }
    }
    const failure = result.failure ? toRecord(result.failure) : null
    // Working now: a question about it is moot.
    if (result.ok && before.question?.messageId)
      this.deps.acknowledge?.(before.question.messageId)
    const state = recipeStates.saveRecipeState({
      ...before,
      state: result.ok ? "verified" : "broken",
      commit: result.ok ? head.commit : null,
      failure,
      // Cumulative, for the scorecard: the loop's bound is its own count.
      repairAttempts: before.repairAttempts,
      question: result.ok ? null : before.question,
    })
    return { ok: result.ok, cached: false, state, failure, result }
  }

  // Make sure the app runs: verify, then repair (bounded), then ask the user.
  // `guidance` carries what the user agreed to into the repair objective.
  async ensureRunnable(input: {
    target: VerifyTarget
    userStoryId?: string | null
    attempts?: number
    guidance?: string
    // The failure the user just answered a question about: a new question
    // says whether that one is fixed.
    answered?: string | null
  }): Promise<EnsureOutcome> {
    const { target } = input
    const userStoryId = input.userStoryId ?? null
    let outcome = await this.verify(target)
    let repairs = 0
    if (outcome.ok) return { ok: true, state: outcome.state, repairs }
    if (!this.recipe(target.workspaceId).services.length)
      return {
        ok: false,
        noRecipe: true,
        state: outcome.state,
        failure: null,
        repairs,
        question: null,
      }
    const initialFailure = outcome.failure
    const attempts = input.attempts ?? DEFAULT_REPAIR_ATTEMPTS
    while (
      !outcome.ok &&
      repairs < attempts &&
      this.deps.repairTurn &&
      this.repairable(target.workspaceId) &&
      outcome.failure?.class === "environment" &&
      !target.signal?.aborted
    ) {
      const branch = outcome.state.branch
      try {
        await this.deps.repairTurn({
          featureId: target.featureId,
          userStoryId,
          root: target.root,
          mainRoot: target.mainRoot,
          owner: `recipe-repair:${target.workspaceId}:${branch}:${repairs + 1}`,
          objective: repairObjective({
            failure: outcome.failure,
            recipe: this.recipe(target.workspaceId),
            attempt: repairs + 1,
            attempts,
            guidance: input.guidance ?? null,
          }),
          signal: target.signal,
        })
      } catch (err) {
        // The turn couldn't run at all (no builder seat, no agent): that's
        // not an attempt, and trying again won't help. Ask instead.
        console.warn("[app-recipe] repair turn couldn't run:", err)
        break
      }
      repairs++
      const recorded = recipeStates.saveRecipeState({
        ...this.state(target.workspaceId, branch),
        repairAttempts: outcome.state.repairAttempts + 1,
      })
      recordEvent({
        featureId: target.featureId,
        userStoryId,
        type: "recipe_repair",
        refId: `${target.workspaceId}:${branch}:${recorded.repairAttempts}`,
        detail: {
          attempt: repairs,
          reason: outcome.failure?.reason,
          summary: outcome.failure?.summary.slice(0, 300),
        },
      })
      this.changed(target.featureId)
      outcome = await this.verify(target)
    }
    if (outcome.ok)
      return {
        ok: true,
        state: outcome.state,
        repairs,
        repairedFrom: initialFailure,
      }
    const question = target.signal?.aborted
      ? null
      : this.ask({
          target,
          userStoryId,
          failure: outcome.failure,
          branch: outcome.state.branch,
          answered: input.answered ?? null,
        })
    return {
      ok: false,
      noRecipe: false,
      state: this.state(target.workspaceId, outcome.state.branch),
      failure: outcome.failure,
      repairs,
      question,
    }
  }

  // Escalate in plain language with concrete choices. One open question per
  // branch: a newer failure replaces it.
  private ask(input: {
    target: VerifyTarget
    userStoryId: string | null
    failure: AppRecipeFailureRecord | null
    branch: string
    answered?: string | null
  }): AppRecipeQuestion | null {
    const { target, failure } = input
    if (!failure) return null
    const recipe = this.recipe(target.workspaceId)
    const prerequisite = failure.prerequisite
      ? recipe.prerequisites?.find((p) => p.key === failure.prerequisite)
      : null
    const asked = questionFor({
      failure,
      prerequisite,
      repairable: !!this.deps.repairTurn && this.repairable(target.workspaceId),
    })
    const { choices } = asked
    const question = followUp(asked.question, input.answered ?? null, failure)
    const previous = this.state(target.workspaceId, input.branch).question
    if (previous?.messageId) this.deps.acknowledge?.(previous.messageId)
    const pending: AppRecipeQuestion = {
      id: randomUUID(),
      featureId: target.featureId,
      userStoryId: input.userStoryId,
      messageId: null,
      question,
      choices,
      askedAt: Date.now(),
      about: failureKey(failure),
    }
    // The question is kept (and answerable on the analysis item) even when
    // Comms can't carry it.
    try {
      pending.messageId =
        this.deps.escalate?.({
          featureId: target.featureId,
          userStoryId: input.userStoryId,
          body: `${question}\n\nWhat happened: ${failure.summary}\n\nChoose in Mission Control: ${choices.map((c) => c.label).join(" / ")}.`,
        }) ?? null
    } catch (err) {
      console.warn("[app-recipe] couldn't post the question to Comms:", err)
    }
    recipeStates.saveRecipeState({
      ...this.state(target.workspaceId, input.branch),
      question: pending,
    })
    const { signal: _signal, onVerify: _onVerify, ...rest } = target
    this.contexts.set(pending.id, {
      target: { ...rest, branch: input.branch },
      userStoryId: input.userStoryId,
    })
    this.changed(target.featureId)
    return pending
  }

  // The user picked a choice. Applies it — never a command the user typed —
  // and resolves with what happened.
  async answer(
    questionId: string,
    choiceId: string
  ): Promise<EnsureOutcome | { skipped: true }> {
    const found = recipeStates.findRecipeQuestion(questionId)
    if (!found) throw new Error("That question was already answered.")
    const { state, question } = found
    const choice = question.choices.find((c) => c.id === choiceId)
    if (!choice) throw new Error("That choice is no longer available.")
    recipeStates.saveRecipeState({ ...state, question: null })
    if (question.messageId) this.deps.acknowledge?.(question.messageId)
    this.changed(question.featureId)
    const context =
      this.contexts.get(questionId) ?? this.fallbackContext(state, question)
    this.contexts.delete(questionId)
    return this.apply(choice.effect, question, state, context)
  }

  private async apply(
    effect: AppRecipeChoiceEffect,
    question: AppRecipeQuestion,
    state: AppRecipeState,
    context: QuestionContext | null
  ): Promise<EnsureOutcome | { skipped: true }> {
    if (effect.kind === "skip" || !context) {
      const waiting = this.waiters.get(question.id)
      this.waiters.delete(question.id)
      // A waiting app check ends its story unverified itself.
      if (waiting) waiting({ skipped: true })
      else this.deps.onSkipped?.(question, state.failure)
      return { skipped: true }
    }
    const target = context.target
    // A story's worktree may be gone by now: check the main checkout.
    const usable: VerifyTarget = existsSync(target.root)
      ? target
      : {
          ...target,
          root: target.mainRoot,
          branch: undefined,
          commit: undefined,
        }
    const outcome = await this.ensureRunnable({
      target: usable,
      userStoryId: context.userStoryId,
      // Checking again doesn't repair; "repair" starts a fresh bounded loop.
      attempts: effect.kind === "retry" ? 0 : DEFAULT_REPAIR_ATTEMPTS,
      guidance: effect.kind === "repair" ? effect.guidance : undefined,
      answered:
        question.about ?? (state.failure ? failureKey(state.failure) : null),
    })
    this.deps.onSettled?.(question, outcome)
    const waiting = this.waiters.get(question.id)
    this.waiters.delete(question.id)
    waiting?.(outcome)
    return outcome
  }

  // The app check before a story's QA proof step (plan 112.4's implicit
  // check, brought forward with 112.3): verify the recipe in the story's
  // worktree, repair it, and ask the user, waiting for the answer. None of it
  // spends the story's attempts or proof revisions. "pass": QA starts (also
  // when there's no recipe: QA proves by commands). "unverified": the user
  // chose to stop trying; the caller ends the story unverified. "stopped":
  // the step was cancelled while it waited. `report` is its receipt: each
  // verification's stages, durations, smoke results, and log tail.
  async appCheck(input: {
    featureId: string
    userStoryId: string
    root: string
    signal: AbortSignal
  }): Promise<
    (
      | { result: "pass" }
      | { result: "unverified"; summary: string }
      | { result: "stopped" }
    ) & { report: string }
  > {
    const feature = features.getFeature(input.featureId)
    const workspace = feature?.workspaceId
      ? getWorkspace(feature.workspaceId)
      : null
    if (!workspace || !workspace.appLaunch.services.length)
      return {
        result: "pass",
        report:
          "The app launch recipe has no services: nothing to start. QA proves by commands.",
      }
    const report: string[] = []
    const head = await headOf(input.root)
    // Uncommitted work isn't the commit a verified state holds for.
    const dirty = await git(input.root, ["status", "--porcelain"])
    const target: VerifyTarget = {
      featureId: input.featureId,
      workspaceId: workspace.id,
      root: input.root,
      mainRoot: workspace.path,
      branch: head.branch,
      commit: dirty.ok && !dirty.stdout.trim() ? head.commit : null,
      signal: input.signal,
      onVerify: (outcome) => report.push(verifyReport(outcome)),
    }
    const before = this.state(workspace.id, head.branch)
    let repairs = 0
    let firstFailure: AppRecipeFailureRecord | null = null
    let asked = 0
    const done = <T extends { result: string }>(
      result: T,
      summary?: string
    ): T & { report: string } => {
      recordEvent({
        featureId: input.featureId,
        userStoryId: input.userStoryId,
        type: "app_check",
        refId: `${input.userStoryId}:${randomUUID()}`,
        detail: {
          result: result.result,
          cached:
            result.result === "pass" &&
            !repairs &&
            !firstFailure &&
            before.state === "verified" &&
            before.commit === target.commit,
          repairs,
          questions: asked,
          ...(firstFailure
            ? {
                class: firstFailure.class,
                stage: firstFailure.stage,
                reason: firstFailure.reason,
                summary: firstFailure.summary.slice(0, 300),
              }
            : {}),
          ...(summary ? { unverified: summary.slice(0, 300) } : {}),
          source: this.recipe(workspace.id).services[0]?.source ?? null,
        },
      })
      if (repairs)
        report.push(
          `Recipe repair: ${repairs} attempt${repairs === 1 ? "" : "s"}.`
        )
      if (asked)
        report.push(
          `Asked the user ${asked === 1 ? "once" : `${asked} times`}.`
        )
      return { ...result, report: report.join("\n\n") }
    }
    let outcome = await this.ensureRunnable({
      target,
      userStoryId: input.userStoryId,
    })
    while (!outcome.ok) {
      repairs += outcome.repairs
      firstFailure ??= outcome.failure
      if (input.signal.aborted) return done({ result: "stopped" as const })
      if (outcome.noRecipe) return done({ result: "pass" as const })
      const summary = outcome.failure?.summary ?? "the app didn't start"
      if (!outcome.question)
        return done({ result: "unverified" as const, summary }, summary)
      asked++
      const answer = await this.waitForAnswer(outcome.question.id, input.signal)
      if (!answer) return done({ result: "stopped" as const })
      if ("skipped" in answer)
        return done({ result: "unverified" as const, summary }, summary)
      outcome = answer
    }
    repairs += outcome.repairs
    firstFailure ??= outcome.repairedFrom ?? null
    return done({ result: "pass" as const })
  }

  private waitForAnswer(
    questionId: string,
    signal: AbortSignal
  ): Promise<EnsureOutcome | { skipped: true } | null> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve(null)
      const abort = () => {
        this.waiters.delete(questionId)
        resolve(null)
      }
      signal.addEventListener("abort", abort, { once: true })
      this.waiters.set(questionId, (outcome) => {
        signal.removeEventListener("abort", abort)
        resolve(outcome)
      })
    })
  }

  private fallbackContext(
    state: AppRecipeState,
    question: AppRecipeQuestion
  ): QuestionContext | null {
    const workspace = getWorkspace(state.workspaceId)
    if (!workspace) return null
    return {
      target: {
        featureId: question.featureId,
        workspaceId: workspace.id,
        root: workspace.path,
        mainRoot: workspace.path,
      },
      userStoryId: question.userStoryId,
    }
  }

  // Check the feature's workspace from the analysis panel ("Check that the
  // app starts"): verify, repair, ask. Runs in the background.
  // Check the feature's workspace checkout: from the analysis panel ("Check
  // now"), and on its own after a milestone lands there. Verify, repair, ask.
  // Skipped while the feature's work isn't in the checkout yet: the stories
  // check the app in their own worktrees until it lands.
  async checkFeature(
    featureId: string
  ): Promise<EnsureOutcome | { notInCheckout: string }> {
    const feature = features.getFeature(featureId)
    const workspace = feature?.workspaceId
      ? getWorkspace(feature.workspaceId)
      : null
    if (!feature || !workspace)
      throw new Error("Choose a workspace for this feature first.")
    const pending = await this.workNotInCheckout(featureId, workspace.path)
    if (pending) {
      this.changed(featureId)
      return { notInCheckout: pending }
    }
    return this.ensureRunnable({
      target: {
        featureId,
        workspaceId: workspace.id,
        root: workspace.path,
        mainRoot: workspace.path,
      },
    })
  }

  // Preflight at story start (plan 112.3): a rig with a QA seat whose
  // workspace has no recipe gets one drafted at the story's starting ref
  // (the integration branch, where earlier stories landed), verified in the
  // story's worktree. Failing either, the story starts anyway: the builder's
  // app_launch_save and the app check (112.4) take over. A project with
  // nothing runnable is skipped (the skeleton rule is 112.5's).
  async preflight(input: {
    feature: Feature
    milestone: Milestone
    root: string
    signal?: AbortSignal
  }): Promise<void> {
    const { feature, milestone } = input
    const rig = feature.rigSnapshot
    if (!rig?.seats.some((s) => s.role === "qa") || !feature.workspaceId) return
    const workspace = getWorkspace(feature.workspaceId)
    if (!workspace || workspace.appLaunch.services.length) return
    const detection = await detectAppLaunchAtRef({
      workspace: workspace.path,
      ref: milestone.integrationBranch ?? "HEAD",
    })
    if (!detection?.recipe) return
    // A recipe someone saved meanwhile wins.
    if (getWorkspace(workspace.id)?.appLaunch.services.length) return
    updateWorkspace(workspace.id, { appLaunch: detection.recipe })
    this.changed(feature.id)
    await this.verify({
      featureId: feature.id,
      workspaceId: workspace.id,
      root: input.root,
      mainRoot: workspace.path,
      signal: input.signal,
    })
  }
}

// One verification, for the app check's receipt.
export function verifyReport(outcome: VerifyOutcome): string {
  if (outcome.cached)
    return `Already verified at ${outcome.state.commit?.slice(0, 7) ?? "this commit"}: nothing to run.`
  const lines: string[] = []
  const result = outcome.result
  if (result) {
    lines.push(
      `Stages: ${result.stages.map((s) => `${s.stage} ${(s.ms / 1000).toFixed(1)}s ${s.ok ? "✓" : "✗"}`).join(" · ") || "none"}`
    )
    for (const s of result.smoke)
      lines.push(`GET ${s.url} → ${s.status ?? "no answer"}`)
    if (result.browserSkipped)
      lines.push(`Browser load skipped: ${result.browserSkipped}`)
  }
  const failure = outcome.failure
  if (failure) {
    lines.push(
      `Failed at ${failure.stage} (${failure.reason}, ${failure.class}): ${failure.summary}`
    )
    if (failure.logs) lines.push(failure.logs)
  } else if (outcome.ok) lines.push("The app started and passed smoke.")
  return lines.join("\n")
}

// A question asked right after the user answered one says how that went:
// fixed and on to the next problem, or the same problem still.
export function followUp(
  question: string,
  answered: string | null,
  failure: AppRecipeFailureRecord
): string {
  if (!answered) return question
  return answered === failureKey(failure)
    ? `That didn't fix it. ${question}`
    : `That's fixed. Now: ${question}`
}

// The repair seat's objective: recipe-only, with the failure, its class, the
// captured logs, and the current recipe.
export function repairObjective(input: {
  failure: AppRecipeFailureRecord | null
  recipe: AppLaunch
  attempt: number
  attempts: number
  guidance: string | null
}): string {
  const { failure } = input
  return [
    "# Recipe repair",
    `The app doesn't start from its app launch recipe. Fix the recipe — only the recipe — so it does. This is repair attempt ${input.attempt} of ${input.attempts}.`,
    "",
    "## What failed",
    failure
      ? [
          `- Stage: ${failure.stage} (${failure.reason}); class: ${failure.class}`,
          `- ${failure.summary}`,
          ...(failure.missingEnv?.length
            ? [`- Unresolved .env keys: ${failure.missingEnv.join(", ")}`]
            : []),
          ...(failure.logs
            ? ["", "The end of its output:", "```", failure.logs, "```"]
            : []),
        ].join("\n")
      : "(no details)",
    "",
    "## The current recipe",
    "```json",
    JSON.stringify(input.recipe, null, 2),
    "```",
    ...(input.guidance ? ["", "## From the user", input.guidance] : []),
    "",
    "## Rules",
    "- Read the project (manifests, README, scripts, .env.example) and run diagnostic commands to find what the app needs. Don't change product code: the app is not what's broken, the recipe is.",
    "- The recipe must start the project's own code. Never replace it with a stand-in (a one-line server, a stub that answers the readiness check): if the project's code isn't there to start, say so in your final message and stop.",
    "- Save the fixed recipe with `app_launch_save` (pass the whole recipe). It's started in this worktree and saved only if every service becomes ready and passes smoke.",
    "- A step that must run first (a migration, a seed, a build) goes in `setup`; never chain commands with && or install dependencies.",
    "- An environment value from .env.local or .env goes in a service's `env` as `{env:KEY}` — never the value itself. Another service's port is `{port:<key>}`.",
    "- Something the app needs that the recipe can't start (a database the user runs) is a `prerequisite` with a plain-language label and hint.",
    "- If the app needs something only the user can provide (a secret, an account), say exactly what in your final message and stop: the user is asked in plain language.",
  ].join("\n")
}

let installed: AppRecipeService | null = null

export function installAppRecipeService(
  instance: AppRecipeService | null
): void {
  installed = instance
}

export function getAppRecipeService(): AppRecipeService | null {
  return installed
}
