import { describe, expect, it } from "vitest"
import type { FailureClass } from "../../shared/mission-control/app-recipe"
import { classifyRunFailure, type RunFailureEvidence } from "./run-failure"

// Plan 112.3, part 4: the classification table. Structured input first
// (the harness's stage, Playwright's report); log patterns only break ties.

const launch = (
  stage: string,
  reason: string,
  missingEnv?: string[]
): RunFailureEvidence["launch"] =>
  ({ stage, reason, ...(missingEnv ? { missingEnv } : {}) }) as never

const report = (
  tests: Array<{ status: string; error?: string }>,
  errors: string[] = []
) => ({ tests, errors })

const cases: Array<[string, RunFailureEvidence, FailureClass]> = [
  // Environment: the harness stopped before the app was up and loading.
  [
    "a prerequisite check failed",
    {
      launch: launch("prerequisites", "prerequisite_unavailable"),
      smokeVerified: false,
    },
    "environment",
  ],
  [
    "setup exited non-zero",
    { launch: launch("setup", "setup_failed"), smokeVerified: false },
    "environment",
  ],
  [
    "a service exited before ready",
    { launch: launch("ready", "exited_early"), smokeVerified: false },
    "environment",
  ],
  [
    "readiness timeout",
    { launch: launch("ready", "ready_timeout"), smokeVerified: false },
    "environment",
  ],
  [
    "5xx at smoke",
    { launch: launch("smoke", "smoke_status"), smokeVerified: false },
    "environment",
  ],
  [
    "an unresolved {env:KEY}",
    {
      launch: launch("start", "missing_env", ["DATA_FILE"]),
      smokeVerified: false,
    },
    "environment",
  ],
  [
    "a harness failure even after the app was verified",
    { launch: launch("ready", "exited_early"), smokeVerified: true },
    "environment",
  ],
  [
    "net::ERR_ before the first assertion",
    {
      smokeVerified: true,
      playwright: report([
        {
          status: "failed",
          error:
            "page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:4000/",
        },
      ]),
    },
    "environment",
  ],
  [
    "connection refused in a run that loaded nothing",
    {
      smokeVerified: true,
      playwright: report([], ["Error: connect ECONNREFUSED 127.0.0.1:4000"]),
    },
    "environment",
  ],
  [
    "a missing variable in the log tail",
    {
      smokeVerified: true,
      logTail: "Error: DATA_FILE is not set (see .env.local)",
    },
    "environment",
  ],
  [
    "a migration error before smoke passed",
    { smokeVerified: false, logTail: 'relation "items" does not exist' },
    "environment",
  ],
  // Feature: misbehavior against a running, smoke-passing app.
  [
    "an assertion failure after smoke passed",
    {
      smokeVerified: true,
      playwright: report([
        {
          status: "failed",
          error:
            'Error: expect(locator).toHaveText(expected)\nExpected: "1 items"\nReceived: "0 items"',
        },
      ]),
    },
    "feature",
  ],
  [
    "an unknown failure after smoke passed",
    { smokeVerified: true, logTail: "something odd" },
    "feature",
  ],
  // Test defect: QA's own spec.
  [
    "a syntax error in the spec",
    {
      smokeVerified: true,
      playwright: report(
        [],
        ["SyntaxError: Unexpected token '}' in story.spec.ts"]
      ),
    },
    "test_defect",
  ],
  [
    "an import error in the spec",
    {
      smokeVerified: true,
      playwright: report([], ["Error: Cannot find module './helpers'"]),
    },
    "test_defect",
  ],
  [
    "No tests found for QA's spec",
    {
      smokeVerified: true,
      playwright: report([], []),
      logTail: "Error: No tests found",
    },
    "test_defect",
  ],
  // Unknown defaults.
  [
    "an unknown failure before smoke",
    { smokeVerified: false, logTail: "something odd" },
    "environment",
  ],
  [
    "an assertion against an app that never passed smoke",
    {
      smokeVerified: false,
      playwright: report([{ status: "failed", error: "expect(x).toBe(y)" }]),
    },
    "environment",
  ],
]

describe("classifyRunFailure", () => {
  for (const [name, evidence, expected] of cases)
    it(`${name} → ${expected}`, () => {
      const result = classifyRunFailure(evidence)
      expect(result.class).toBe(expected)
      expect(result.signal).toBeTruthy()
    })
})
