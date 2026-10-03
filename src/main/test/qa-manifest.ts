import { mkdirSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import * as processes from "../db/repositories/processes"
import { storyChecks } from "../mission-control/qa-checks"

// What a fake QA seat writes in the checks step (plan 109.02), so tests that
// drive the default user story playbook get past its manifest gate: one
// exploratory check per acceptance criterion. A no-op for any other turn.
export function writeFakeManifest(input: {
  processQaChecks?: "author" | "verify"
  processRunId?: string
  workspace?: string
}): void {
  if (input.processQaChecks !== "author" || !input.workspace) return
  const run = processes.getProcessRun(input.processRunId!)
  const story = run?.missionControl ? storyChecks(run.missionControl) : null
  if (!story) return
  const path = join(input.workspace, story.manifestPath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    JSON.stringify({
      criteria: Object.fromEntries(
        story.criterionIds.map((id) => [
          id,
          [{ id: `${story.storyRef}-${id}`, kind: "exploratory", note: id }],
        ])
      ),
    })
  )
}
