import { createHash } from "crypto"
import path from "path"
import {
  sortFindings,
  type Finding,
  type Fix,
  type WorkspaceSettingsPatch,
} from "../../../shared/mission-control/workspace-analysis"
import type { CurrentSettings } from "./analyze"
import type { FindingDraft } from "./draft"

// Stage 8 (plan 106.11): drafts become findings. Deduplicate by key, resolve
// findings the current settings already satisfy ("Already configured"), keep
// dismissed findings dismissed while their evidence is unchanged, and order
// by severity then category.

export type Dismissals = Record<string, string>

export function evidenceHash(
  draft: Pick<FindingDraft, "evidence" | "title">
): string {
  return createHash("sha1")
    .update(draft.title)
    .update(
      JSON.stringify(draft.evidence.map((e) => [e.kind, e.label, e.path ?? ""]))
    )
    .digest("hex")
    .slice(0, 16)
}

function norm(p: string) {
  return p
    .trim()
    .replace(/^\.?\/+/, "")
    .replace(/\/+$/, "")
}

function sameStep(
  a: { command: string; cwd: string },
  b: { command: string; cwd: string }
) {
  return a.command.trim() === b.command.trim() && norm(a.cwd) === norm(b.cwd)
}

function globCovers(existing: string, wanted: string): boolean {
  if (norm(existing) === norm(wanted)) return true
  try {
    return path.posix.matchesGlob(
      norm(wanted).replace(/\/\*\*$/, "/x"),
      norm(existing)
    )
  } catch {
    return false
  }
}

export function ruleCovered(
  settings: CurrentSettings,
  rule: { paths: string[]; command: string }
): "same" | "other-command" | null {
  const covering = settings.generatedFiles.filter((r) =>
    rule.paths.every((p) => r.paths.some((g) => globCovers(g, p)))
  )
  if (!covering.length) {
    // Covered piecewise by several rules.
    const all = rule.paths.every((p) =>
      settings.generatedFiles.some((r) => r.paths.some((g) => globCovers(g, p)))
    )
    if (!all) return null
  }
  return covering.some((r) => r.command.trim() === rule.command.trim())
    ? "same"
    : "other-command"
}

// Is the patch already in effect?
export function patchSatisfied(
  settings: CurrentSettings,
  patch: WorkspaceSettingsPatch
): boolean {
  if (patch.overlapPolicy && settings.overlapPolicy !== patch.overlapPolicy)
    return false
  const links = new Set(settings.linkPaths.map(norm))
  if (patch.worktreeLinkPaths?.add?.some((p) => !links.has(norm(p))))
    return false
  if (patch.worktreeLinkPaths?.remove?.some((p) => links.has(norm(p))))
    return false
  if (
    patch.worktreeSetupSteps?.add?.some(
      (step) => !settings.steps.some((s) => sameStep(s, step))
    )
  )
    return false
  if (patch.generatedFiles?.add?.some((rule) => !ruleCovered(settings, rule)))
    return false
  if (
    patch.appLaunch?.add?.some(
      (service) =>
        !(settings.appServices ?? []).some((s) => sameStep(s, service))
    )
  )
    return false
  return true
}

function fixPatch(fix: Fix): WorkspaceSettingsPatch | null {
  if (fix.kind === "apply-settings") return fix.patch
  return null
}

export function assembleFindings(input: {
  drafts: FindingDraft[]
  settings: CurrentSettings
  dismissals: Dismissals
  // Last run outcomes to carry over, by key.
  previous?: Finding[]
}): Finding[] {
  const byKey = new Map<string, FindingDraft>()
  for (const draft of input.drafts)
    if (!byKey.has(draft.key)) byKey.set(draft.key, draft)
  const findings: Finding[] = []
  for (const draft of byKey.values()) {
    const evidence = draft.evidence.map((e, i) => ({
      ...e,
      id: `${draft.key}#${i}`,
    }))
    const finding: Finding = {
      ...draft,
      evidence,
      alternatives: draft.alternatives ?? [],
      status: "open",
    }
    const previous = input.previous?.find((f) => f.key === draft.key)
    if (previous?.lastRun) finding.lastRun = previous.lastRun
    if (draft.resolution) {
      finding.status = "resolved"
    } else {
      const patch = fixPatch(draft.fix)
      if (patch && patchSatisfied(input.settings, patch)) {
        finding.status = "resolved"
        const generated = patch.generatedFiles?.add?.[0]
        finding.resolution =
          generated &&
          ruleCovered(input.settings, generated) === "other-command"
            ? "Already configured (with your command)"
            : "Already configured"
      } else {
        const ownRecipe =
          !!fixPatch(draft.fix)?.appLaunch?.add?.length &&
          !!input.settings.appServices?.length
        const alternative = draft.alternatives?.find((alt) => {
          const altPatch = fixPatch(alt)
          return altPatch && patchSatisfied(input.settings, altPatch)
        })
        const mainPatch = fixPatch(draft.fix)
        const altSteps =
          (alternative && fixPatch(alternative)?.worktreeSetupSteps?.add) || []
        const installedBySetup = input.settings.steps.filter((s) =>
          altSteps.some((a) => sameStep(s, a))
        )
        const links = mainPatch?.worktreeLinkPaths?.add ?? []
        if (
          alternative &&
          links.length &&
          installedBySetup.length &&
          installedBySetup.every((s) => s.source === "analysis")
        ) {
          // Worktrees install it because it didn't exist when the setup was
          // chosen; now it does and it's safe to share: offer the link.
          finding.severity = "info"
          finding.title = `Faster: link ${links.join(", ")} instead of installing it in every worktree`
          finding.explanation = `${draft.explanation} Each new worktree currently runs the install instead; linking skips it.`
          finding.fix = {
            kind: "apply-settings",
            summary: `Link ${links.join(", ")} and drop the per-worktree install`,
            patch: {
              ...mainPatch,
              worktreeSetupSteps: { remove: installedBySetup.map((s) => s.id) },
            },
          }
          finding.alternatives = []
        } else if (alternative || ownRecipe) {
          // An app launch recipe the user wrote: don't second-guess it.
          finding.status = "resolved"
          finding.resolution = "Configured another way"
        }
      }
    }
    if (
      finding.status === "open" &&
      input.dismissals[draft.key] === evidenceHash(draft)
    )
      finding.status = "dismissed"
    findings.push(finding)
  }

  // Parallel stories: say what's still in the way.
  const parallel = findings.find((f) => f.key === "git-isolation:parallel")
  if (parallel && parallel.status === "open") {
    const pending = findings.filter(
      (f) =>
        f.status === "open" &&
        (f.category === "worktree-environment" ||
          f.category === "local-config" ||
          f.category === "generated-files")
    )
    if (pending.length)
      parallel.explanation += ` ${pending.length} worktree setup finding${pending.length === 1 ? " is" : "s are"} still open; fix ${pending.length === 1 ? "it" : "them"} first so parallel worktrees can run the project.`
  }
  return sortFindings(findings)
}

// A settings change with no command in it: links and the overlap policy.
// Setup steps and regeneration rules persist commands, which the user
// confirms first (plan 106.11 principle 5).
function commandFree(patch: WorkspaceSettingsPatch): boolean {
  // Nothing that saves a command, and nothing that removes what's there.
  return (
    !patch.worktreeSetupSteps?.add?.length &&
    !patch.generatedFiles?.add?.length &&
    !patch.appLaunch?.add?.length &&
    !patch.worktreeSetupSteps?.remove?.length &&
    !patch.worktreeLinkPaths?.remove?.length
  )
}

// The findings Start may apply on its own: verified, settings-only, command
// free, not replacing anything the user wrote. Parallel scheduling only once
// no worktree, local-config, or generated-files finding stays open.
export function autoApplicable(findings: Finding[]): Finding[] {
  const open = findings.filter((f) => f.status === "open")
  const safe = (f: Finding) =>
    f.fix.kind === "apply-settings" &&
    f.confidence === "verified" &&
    !f.replacesUserSetting &&
    commandFree(f.fix.patch)
  const envOpen = open.some(
    (f) =>
      (f.category === "worktree-environment" ||
        f.category === "generated-files" ||
        f.category === "local-config") &&
      !safe(f)
  )
  return open.filter((f) => {
    if (!safe(f) || f.fix.kind !== "apply-settings") return false
    if (f.fix.patch.overlapPolicy === "parallel") return !envOpen
    return true
  })
}
