import { mkdir, writeFile } from "fs/promises"
import * as features from "../db/repositories/features"
import type { MissionControlRunLink } from "../db/types"
import type { WriteScope } from "../agent/tools/write_scope"
import { resolveInWorkspaceReal } from "../agent/tools/workspace"
import type { ContextSection } from "../agent/context/context-builder"
import { SEAT_CONTEXT_PRIORITY } from "./seat-context"

// The role whose seats verify rather than build. They change no product code.
export const QA_ROLE = "qa"
// Where a QA step's throwaway files go, per run. Ignores itself, so it's never
// committed with the user story.
export const SCRATCH_DIR = ".mission-control/scratch"

// A scoped seat's turn: where its write-family tools may write, and the
// context section that tells it so.
export interface SeatScope {
  writeScope: WriteScope
  contextSection: ContextSection
}

// A user story run's reference, e.g. `CHK.M1.US2`. Null for a milestone run.
export function storyRefForRun(link: MissionControlRunLink): string | null {
  const feature = features.getFeature(link.featureId)
  const userStory = link.userStoryId
    ? features.getUserStory(link.userStoryId)
    : null
  const milestone = userStory
    ? features.getMilestone(userStory.milestoneId)
    : null
  return feature && userStory && milestone
    ? `${feature.key}.${milestone.key}.${userStory.key}`
    : null
}

// The scope of a QA seat's turn (plan 112.4): it may write only the run's
// scratch directory; every other role is unrestricted (undefined). The
// acceptance-checks directory comes with 112.5's suite. Resolved server-side
// when the phase starts, never from model arguments.
export async function seatWriteScope(input: {
  role: string
  runId: string
  workingDirectory: string | undefined
}): Promise<SeatScope | undefined> {
  if (input.role !== QA_ROLE) return undefined
  const scratch = `${SCRATCH_DIR}/${input.runId}`
  const scope: SeatScope = {
    writeScope: { allow: [scratch] },
    contextSection: writeScopeContextSection(scratch),
  }
  if (!input.workingDirectory) return scope
  try {
    // Real-path checked: a symlinked parent must not create folders elsewhere.
    const root = input.workingDirectory
    await mkdir(await resolveInWorkspaceReal(root, scratch), {
      recursive: true,
    })
    const ignore = await resolveInWorkspaceReal(root, `${scratch}/.gitignore`)
    await writeFile(ignore, "*\n", { flag: "wx" }).catch(
      (err: NodeJS.ErrnoException) => {
        if (err.code !== "EEXIST") throw err
      }
    )
  } catch (err) {
    // The scope still holds; the seat just meets a missing directory.
    console.warn("[qa-scope] could not prepare the scratch directory:", err)
  }
  return scope
}

// Tells the seat where it may write before it tries, so the tools'
// `out_of_scope` refusal is a backstop, not how it finds out.
export function writeScopeContextSection(scratch: string): ContextSection {
  return {
    name: "mission_control_write_scope",
    priority: SEAT_CONTEXT_PRIORITY,
    content: [
      "## Where you may write",
      `In this step you verify by exploring the running app, and you write nothing in the repository. You can create, edit, move, and delete files only inside \`${scratch}/\`: throwaway scripts, logs, and notes. Never committed.`,
      "",
      "Every other path in the workspace is read-only to you, and the file tools refuse writes there. Don't work around that with shell commands: you verify product code, you don't change it. Report what's wrong as findings in your proof.",
    ].join("\n"),
    provenance: {
      trust: "system",
      channel: "runtime",
      source: "mission_control_write_scope",
    },
  }
}
