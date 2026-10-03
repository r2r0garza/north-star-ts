import { mkdirSync, mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { evidenceDir, setEvidenceRoot } from "../mission-control/evidence"
import * as processes from "../db/repositories/processes"
import { storyChecks } from "../mission-control/qa-checks"

// What a fake QA seat writes in the checks step (plan 109.02), so tests that
// drive the default user story playbook get past its manifest gate: one
// exploratory check per acceptance criterion, or, given a command, one
// automated check running it. A no-op for any other turn.
export function writeFakeManifest(
  input: {
    processQaChecks?: "author" | "verify"
    processRunId?: string
    workspace?: string
  },
  command?: string
): void {
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
          [
            command
              ? {
                  id: `${story.storyRef}-${id}`,
                  kind: "automated",
                  command: `${command} @${story.storyRef}`,
                  cwd: "",
                  timeoutMs: 30000,
                }
              : {
                  id: `${story.storyRef}-${id}`,
                  kind: "exploratory",
                  note: id,
                },
          ],
        ])
      ),
    })
  )
}

// What a fake QA seat cites in the test step (plan 109.05): its fake manifest
// marks every criterion exploratory, so each criterion the test didn't give a
// method is proven "app_exercised" with a screenshot saved in the step's
// evidence directory (a temp evidence root when none is set).
export function proveInApp(
  phaseRunId: string,
  args: Record<string, unknown>
): Record<string, unknown> {
  if (!evidenceDir(phaseRunId))
    setEvidenceRoot(mkdtempSync(join(tmpdir(), "mc-evidence-")))
  const dir = evidenceDir(phaseRunId)!
  mkdirSync(dir, { recursive: true })
  const shot = join(dir, "screenshot-001.jpg")
  writeFileSync(shot, "jpeg")
  const criteria = Array.isArray(args.criteria) ? args.criteria : []
  return {
    ...args,
    criteria: criteria.map((c: Record<string, unknown>) =>
      c.method ? c : { ...c, method: "app_exercised", artifacts: [shot] }
    ),
  }
}
