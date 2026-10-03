import { mkdir, writeFile } from "fs/promises"
import * as features from "../db/repositories/features"
import { getWorkspace } from "../db/repositories/workspaces"
import type { MissionControlRunLink } from "../db/types"
import type { WriteScope } from "../agent/tools/write_scope"
import { resolveInWorkspaceReal } from "../agent/tools/workspace"
import { gitSucceeds } from "../agent/subagents/worktrees"
import type { ContextSection } from "../agent/context/context-builder"
import { SEAT_CONTEXT_PRIORITY } from "./seat-context"
import {
  DEFAULT_CHECKS_DIR,
  SCRATCH_DIR,
  userStoryRef,
} from "../../shared/mission-control/checks"

// The role whose seats verify rather than build (plan 109.01). They write
// acceptance checks, never product code.
export const QA_ROLE = "qa"

// A scoped seat's turn: where its write-family tools may write, and the
// context section that tells it so (and how to organize its checks).
export interface SeatScope {
  writeScope: WriteScope
  contextSection: ContextSection
}

// The run's checks directory (the workspace setting) and, for a user story
// run, the story's reference. A milestone run (e.g. reverify) has no story.
function checksForRun(link: MissionControlRunLink): {
  checksDir: string
  storyRef: string | null
} {
  const feature = features.getFeature(link.featureId)
  const workspace = feature?.workspaceId
    ? getWorkspace(feature.workspaceId)
    : null
  const checksDir = workspace?.missionControl.checksDir ?? DEFAULT_CHECKS_DIR
  const userStory = link.userStoryId
    ? features.getUserStory(link.userStoryId)
    : null
  const milestone = userStory
    ? features.getMilestone(userStory.milestoneId)
    : null
  return {
    checksDir,
    storyRef:
      feature && userStory && milestone
        ? userStoryRef({
            featureKey: feature.key,
            milestoneKey: milestone.key,
            userStoryKey: userStory.key,
          })
        : null,
  }
}

// The scope of a seat's turn, resolved server-side when its phase starts. A
// `qa` seat may write only the workspace's checks directory and the run's
// scratch directory; every other role is unrestricted (undefined). Checks are
// shared test code (page objects, fixtures, specs by product area), so the
// whole checks directory is in scope, not a folder per story. Both
// directories are created up front, and the scratch directory ignores itself
// so `git add -A` on the user story branch never commits it. Throws
// ChecksDirIgnoredError when git ignores the checks directory.
export async function seatWriteScope(input: {
  role: string
  link: MissionControlRunLink
  runId: string
  workingDirectory: string | undefined
}): Promise<SeatScope | undefined> {
  if (input.role !== QA_ROLE) return undefined
  const { checksDir, storyRef } = checksForRun(input.link)
  const scratch = `${SCRATCH_DIR}/${input.runId}`
  const scope: SeatScope = {
    writeScope: { allow: [checksDir, scratch] },
    contextSection: writeScopeContextSection({ checksDir, scratch, storyRef }),
  }
  if (!input.workingDirectory) return scope
  const root = input.workingDirectory
  try {
    // Real-path checked: a symlinked parent must not create folders elsewhere.
    for (const dir of [checksDir, scratch])
      await mkdir(await resolveInWorkspaceReal(root, dir), { recursive: true })
    const ignore = await resolveInWorkspaceReal(root, `${scratch}/.gitignore`)
    await writeFile(ignore, "*\n", {
      flag: "wx",
    }).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "EEXIST") throw err
    })
  } catch (err) {
    // The scope still holds; the seat just meets a missing directory.
    console.warn("[qa-scope] could not prepare the QA directories:", err)
  }
  // Checks git ignores would never be committed with the user story, so the
  // user couldn't re-run them and `reverify` would find nothing. Refuse the
  // step rather than lose them silently. (Not a repository: nothing to check.)
  if (await gitSucceeds(root, ["check-ignore", "-q", `${checksDir}/check`]))
    throw new ChecksDirIgnoredError(checksDir)
  return scope
}

export class ChecksDirIgnoredError extends Error {
  constructor(dir: string) {
    super(
      `The checks directory "${dir}" is ignored by git, so QA's checks would never be committed with the user story. Remove it from .gitignore, or choose another checks directory in Feature home → Review setup → Advanced settings.`
    )
    this.name = "ChecksDirIgnoredError"
  }
}

// Tells a scoped seat where it may write before it tries, so the tool's
// `out_of_scope` refusal is a backstop, not how it finds out, and how checks
// are organized so stories share page objects instead of duplicating them.
export function writeScopeContextSection(input: {
  checksDir: string
  scratch: string
  storyRef: string | null
}): ContextSection {
  const { checksDir, scratch, storyRef } = input
  const lines = [
    "## Where you may write",
    "In this step you can create, edit, move, and delete files only inside:",
    `- \`${checksDir}/\`: the project's acceptance checks, committed with the user story.`,
    `- \`${scratch}/\`: throwaway files (logs, output, notes). Never committed.`,
    "",
    "Every other path in the workspace is read-only to you, and the file tools refuse writes there. Don't work around that with shell commands: you verify product code, you don't change it. Report what's wrong as findings in your proof.",
    "",
    "## How checks are organized",
    `\`${checksDir}/\` is shared test code, organized by what it tests, not by user story. Other user stories' checks live there too.`,
    `- If \`${checksDir}/\` or the project already has a structure (page objects, fixtures, helpers, file naming), follow it.`,
    `- Otherwise use the page object pattern: \`${checksDir}/pages/\` for page objects (one per page or screen, holding its locators and actions), \`${checksDir}/fixtures/\` for shared setup, and \`${checksDir}/specs/\` for tests grouped by product area (e.g. \`invoices.spec.ts\`). For a project without a UI, keep shared helpers in \`${checksDir}/support/\` instead of page objects.`,
    "- Reuse existing page objects and helpers before writing new ones. Add methods rather than changing existing ones: other stories' checks depend on them, and may be changing them in parallel.",
  ]
  if (storyRef)
    lines.push(
      `- Tag every check you write for this user story with \`@${storyRef}\` and its criterion id, in the test's name or the framework's tagging mechanism, e.g. \`test("totals are computed @${storyRef} @AC-2", …)\`. That's how a story's checks are found and re-run on their own (\`--grep @${storyRef}\`).`
    )
  return {
    name: "mission_control_write_scope",
    priority: SEAT_CONTEXT_PRIORITY,
    content: lines.join("\n"),
    provenance: {
      trust: "system",
      channel: "runtime",
      source: "mission_control_write_scope",
    },
  }
}
