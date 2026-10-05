import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { evidenceDir, setEvidenceRoot } from "../mission-control/evidence"
import * as processes from "../db/repositories/processes"
import { gateChecks, storyChecks } from "../mission-control/qa-checks"
import { storyManifestPath } from "../../shared/mission-control/checks"
import { recordWaveGate } from "../mission-control/gate-step"

// What a fake QA seat writes in the checks step (plan 109.02; only playbooks
// from before plan 110.04 have one), so tests that drive such a playbook get
// past its manifest gate: one exploratory check per acceptance criterion, or,
// given a command, one automated check running it. A no-op for any other turn.
export function writeFakeManifest(
  input: {
    processQaChecks?: "author" | "explore" | "smoke" | "gate"
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

// What a fake QA seat cites in the test step (plans 109.05, 110.04): each
// criterion the test didn't give a method is proven "app_exercised" with a
// screenshot saved in the step's evidence directory (a temp evidence root
// when none is set).
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

// What a fake QA seat records at a wave gate (plan 110.02): every criterion
// of the batch passed, proven by a screenshot. A batch story without a
// manifest (its playbook had no checks step, plan 110.04) gets one marking
// every criterion exploratory, as the gate's QA writes it. `outcomes`
// overrides a criterion ("<storyKey> AC-1") with another outcome's fields. A
// no-op for any other turn.
export async function recordFakeGate(
  input: {
    processQaChecks?: "author" | "explore" | "smoke" | "gate"
    processRunId?: string
    processPhaseRunId?: string
    workspace?: string
  },
  outcomes: Record<string, Record<string, unknown>> = {}
) {
  if (input.processQaChecks !== "gate" || !input.workspace) return null
  const run = processes.getProcessRun(input.processRunId!)
  const gate = run?.missionControl ? gateChecks(run.missionControl) : null
  if (!gate) return null
  for (const story of gate.stories.values()) {
    if (!story.batch || !story.criteria.length) continue
    const path = join(
      input.workspace,
      storyManifestPath(gate.checksDir, story.storyRef)
    )
    if (existsSync(path)) continue
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(
      path,
      JSON.stringify({
        criteria: Object.fromEntries(
          story.criteria.map((c) => [
            c.id,
            [
              {
                id: `${story.storyRef}-${c.id}`,
                kind: "exploratory",
                note: c.id,
              },
            ],
          ])
        ),
      })
    )
  }
  const shot = proveInApp(input.processPhaseRunId!, {
    criteria: [{ id: "AC-1" }],
  }) as { criteria: Array<{ artifacts: string[] }> }
  const artifacts = shot.criteria[0].artifacts
  return recordWaveGate({
    processRunId: input.processRunId!,
    processPhaseRunId: input.processPhaseRunId!,
    workspace: input.workspace,
    args: {
      stories: [...gate.stories.values()]
        .filter((s) => s.batch && s.criteria.length)
        .map((s) => ({
          story: s.storyRef,
          criteria: s.criteria.map((c) => ({
            id: c.id,
            outcome: "passed",
            evidence: "Saw it in the running app.",
            artifacts,
            ...outcomes[`${s.userStory.key} ${c.id}`],
          })),
        })),
    },
  })
}
