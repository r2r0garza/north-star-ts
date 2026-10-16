import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import path from "path"
import * as waveGates from "../db/repositories/wave-gates"
import {
  gateContext,
  recordWaveGate,
  suiteHash,
} from "../mission-control/gate-step"

// A fake acceptance gate QA step (plan 112.5) for tests that drive the real
// Process engine with a fake agent loop: it extends the suite with one tagged
// test per batch criterion, stores the whole-suite run (no Playwright), and
// records the gate. Earlier gates' tests stay and pass. `outcome` decides
// each criterion ("<story key> <id>" → passed when it returns undefined);
// an app_bug's test fails on an assertion.
export async function fakeGateQa(
  input: {
    processRunId?: string
    processPhaseRunId?: string
    workspace: string
  },
  outcome: (
    storyKey: string,
    id: string
  ) => "passed" | "app_bug" | undefined = () => undefined
): Promise<void> {
  const resolved = gateContext(input.processRunId!, input.processPhaseRunId!)
  if (!resolved.ok) throw new Error(resolved.message)
  const batch = resolved.ctx.stories.filter((s) => s.batch)
  const of = (key: string, id: string) => outcome(key, id) ?? "passed"
  const tests = batch.flatMap((s) =>
    s.criteria.map((c) => {
      const bug = of(s.key, c.id) === "app_bug"
      return {
        title: `${c.text} @${s.storyRef} @${c.id}`,
        file: "specs/gate.spec.ts",
        status: bug ? ("failed" as const) : ("passed" as const),
        ...(bug
          ? {
              error: "expect(locator).toBeVisible() failed",
              class: "feature" as const,
            }
          : {}),
      }
    })
  )
  const spec = path.join(input.workspace, "e2e", "specs", "gate.spec.ts")
  mkdirSync(path.dirname(spec), { recursive: true })
  const earlier = existsSync(spec)
    ? readFileSync(spec, "utf8").split("\n").filter(Boolean)
    : []
  const fresh = tests.filter(
    (t) => !earlier.includes(`test(${JSON.stringify(t.title)})`)
  )
  writeFileSync(
    spec,
    `${[...earlier, ...fresh.map((t) => `test(${JSON.stringify(t.title)})`)].join("\n")}\n`
  )
  const kept = earlier
    .map((line) => JSON.parse(line.slice(5, -1)) as string)
    .filter((title) => !tests.some((t) => t.title === title))
  waveGates.setWaveGateSuiteRun(resolved.ctx.gate.id, {
    hash: await suiteHash(input.workspace),
    ranAt: Date.now(),
    tests: [
      ...kept.map((title) => ({
        title,
        file: "specs/gate.spec.ts",
        status: "passed" as const,
      })),
      ...tests,
    ],
  })
  const recorded = await recordWaveGate({
    processRunId: input.processRunId!,
    processPhaseRunId: input.processPhaseRunId!,
    workspace: input.workspace,
    args: {
      stories: batch.map((s) => ({
        story: s.storyRef,
        criteria: s.criteria.map((c) => ({
          id: c.id,
          outcome: of(s.key, c.id),
          evidence: "Ran the suite.",
          ...(of(s.key, c.id) === "app_bug"
            ? { problem: "The file is missing." }
            : {}),
        })),
      })),
    },
  })
  if (!recorded.ok) throw new Error(recorded.message)
}
