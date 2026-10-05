import { createHash } from "crypto"
import * as features from "../db/repositories/features"
import * as playbooks from "../db/repositories/playbooks"
import * as processes from "../db/repositories/processes"
import type { PlaybookAltitude, PlaybookWithHooks } from "../db/types"
import {
  DEFAULT_PLAYBOOKS,
  diffPlaybookWithDefault,
  ensureDefaultPlaybook,
  resetPlaybookToDefault,
} from "./playbook-defaults"

// Outdated default playbooks (plan 110). Playbooks live in the database and
// are created once, so a new release's defaults never reach an existing
// install unless the user resets them — quick-list ran 110 with 109's
// playbooks. At Start, a default playbook still exactly as an earlier release
// shipped it is upgraded in place; one the user edited, or one other features
// are running on, is only pointed out.

// What identifies a shipped playbook: its name and, per hook, its steps'
// keys, instructions, roles, and proof/validator flags.
interface PlaybookShape {
  name: string
  hooks: Record<
    string,
    Array<{
      key: string
      name: string
      role: string | null
      proofStep: boolean
      validator: boolean
    }>
  >
}

export function shapeFingerprint(shape: PlaybookShape): string {
  const hooks = Object.keys(shape.hooks)
    .sort()
    .map((hook) => [
      hook,
      shape.hooks[hook].map((step) => [
        step.key,
        step.name,
        step.role,
        step.proofStep,
        step.validator,
      ]),
    ])
  return createHash("sha1")
    .update(JSON.stringify([shape.name, hooks]))
    .digest("hex")
    .slice(0, 16)
}

// Every default playbook Mission Control has shipped, by altitude (oldest
// first). Changing DEFAULT_PLAYBOOKS means appending its new fingerprint here
// (a test fails until you do), so installs still on the previous default are
// recognized as unedited and upgraded.
export const SHIPPED_PLAYBOOK_FINGERPRINTS: Record<PlaybookAltitude, string[]> =
  {
    user_story: [
      "e743ff08b255ce6e", // Spec → Build → Test (106.x, after the rename)
      "fffbf00fb2edea44", // proof steps without a validator
      "a6ffae952c31ddf2", // Spec → Author checks → Build → Test (109.02)
      "2691e9f459513d4e", // Spec → Build → Test, exploratory proof (110.04)
    ],
    milestone: [
      "7a3507696cecb4b5", // Plan → Review (106.x, after the rename)
      "815ff8ba4b774f7a", // reverify without a validator
      "0753fd7459d0ca23", // + after_each_wave acceptance gate (110.01)
      "51946162d4e471f9", // reverify as a smoke step (110.05)
    ],
    feature: [
      "9562d31f9047ad60", // Plan → Release
    ],
  }

export function templateFingerprint(altitude: PlaybookAltitude): string {
  const template = DEFAULT_PLAYBOOKS[altitude]
  return shapeFingerprint({
    name: template.name,
    hooks: Object.fromEntries(
      Object.entries(template.hooks).map(([hook, steps]) => [
        hook,
        (steps ?? []).map((step) => ({
          key: step.key,
          name: step.name,
          role: step.role,
          proofStep: step.proofStep ?? false,
          validator: step.validator ?? false,
        })),
      ])
    ),
  })
}

export function playbookFingerprint(playbook: PlaybookWithHooks): string {
  return shapeFingerprint({
    name: playbook.name,
    hooks: Object.fromEntries(
      playbook.hooks.map((hook) => {
        const graph = processes.getProcessGraph(hook.processId)
        const steps = [...(graph?.phases ?? [])]
          .sort((a, b) => a.position - b.position)
          .map((phase) => ({
            key: phase.key,
            name: phase.name,
            role:
              graph!.agents.find((agent) => agent.phaseId === phase.id)
                ?.seatRole ?? null,
            proofStep: !!phase.proofStep,
            validator: !!phase.validator,
          }))
        return [hook.hook, steps]
      })
    ),
  })
}

// The playbooks a feature runs on: its own picks, its milestones' and user
// stories', and each altitude's default.
function playbooksFor(featureId: string): PlaybookWithHooks[] {
  const ids = new Set<string>()
  const feature = features.getFeature(featureId)
  if (feature?.playbookId) ids.add(feature.playbookId)
  for (const milestone of features.listMilestones(featureId)) {
    if (milestone.playbookId) ids.add(milestone.playbookId)
    for (const story of features.listUserStories(milestone.id))
      if (story.playbookId) ids.add(story.playbookId)
  }
  for (const altitude of Object.keys(DEFAULT_PLAYBOOKS) as PlaybookAltitude[])
    ids.add(ensureDefaultPlaybook(altitude).id)
  return [...ids]
    .map((id) => playbooks.getPlaybook(id))
    .filter((p): p is PlaybookWithHooks => !!p)
}

// Before a feature starts: upgrade its outdated, unedited default playbooks,
// unless another feature is in flight on them; say what's left.
export function upgradeDefaultPlaybooks(featureId: string): {
  upgraded: string[]
  notices: string[]
} {
  const upgraded: string[] = []
  const notices: string[] = []
  const inFlight = features
    .listFeatures()
    .filter(
      (f) => f.id !== featureId && ["active", "paused"].includes(f.status)
    )
  for (const playbook of playbooksFor(featureId)) {
    if (!diffPlaybookWithDefault(playbook.id).differs) continue
    const unedited = SHIPPED_PLAYBOOK_FINGERPRINTS[playbook.altitude].includes(
      playbookFingerprint(playbook)
    )
    if (unedited && !inFlight.length) {
      const after = resetPlaybookToDefault(playbook.id)
      upgraded.push(
        `Updated the “${after.name}” playbook to the current default`
      )
      continue
    }
    notices.push(
      `The “${playbook.name}” playbook differs from the current default${
        unedited
          ? `, but ${inFlight.length === 1 ? "another feature is" : `${inFlight.length} other features are`} running on it`
          : " (it was edited)"
      }, so this feature uses it as it is. To use the new default, choose Reset to default… in its playbook picker.`
    )
  }
  return { upgraded, notices }
}
