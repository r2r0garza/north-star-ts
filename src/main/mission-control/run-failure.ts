import type { FailureClass } from "../../shared/mission-control/app-recipe"
import type { LaunchFailure } from "./app-launch"

// Failure classification (plan 112.3, `112` design B). "The app didn't run"
// is not "the feature is wrong": an environment failure goes to recipe
// repair and never counts against a story; a feature failure rejects it; a
// test defect sends QA back to its own check. The input is structured — the
// harness's stage and reason, Playwright's report — and log patterns only
// break ties.

export interface RunFailureEvidence {
  // Where the harness stopped, when the harness failed.
  launch?: Pick<LaunchFailure, "stage" | "reason" | "missingEnv"> | null
  // Whether the app passed smoke verification before this failure: an
  // assertion against an app that was never shown to run proves nothing.
  smokeVerified: boolean
  // A check's Playwright run against the app.
  playwright?: {
    tests: Array<{ status: string; error?: string }>
    errors: string[]
  } | null
  // The end of the app's or the check's output.
  logTail?: string
}

export interface Classification {
  class: FailureClass
  // The signal that decided it, for the record.
  signal: string
}

const TEST_DEFECT =
  /SyntaxError|Cannot find module|ERR_MODULE_NOT_FOUND|Error: No tests found|No tests found|is not a function.*\.spec|Error loading .*(spec|test)/
const BROWSER_NETWORK =
  /net::ERR_[A-Z_]+|ECONNREFUSED|ECONNRESET|page\.goto: .*(Timeout|timed out)/
const ASSERTION =
  /expect\(|toBe|toHave|toEqual|toContain|toMatch|Expected[: ]|Received[: ]|AssertionError/
const MISSING_ENV =
  /\b[A-Z][A-Z0-9_]+ (is not set|isn't set|is required|is missing)|missing (required )?env(ironment)? var|undefined environment variable|KeyError: '[A-Z][A-Z0-9_]+'/i
const ENVIRONMENT_LOG =
  /EADDRINUSE|ECONNREFUSED|could not connect|connection refused|no such table|relation "[^"]+" does not exist|not migrated|migrat(e|ion) (pending|required)/i

export function classifyRunFailure(
  evidence: RunFailureEvidence
): Classification {
  // The harness stopped before the app was up and loading: always the
  // environment (a prerequisite, setup, start, readiness, smoke, an
  // unresolved {env:KEY}, a process that outlived the stop).
  if (evidence.launch)
    return {
      class: "environment",
      signal: evidence.launch.missingEnv?.length
        ? `missing env: ${evidence.launch.missingEnv.join(", ")}`
        : `${evidence.launch.stage}: ${evidence.launch.reason}`,
    }

  const report = evidence.playwright
  if (report) {
    const failed = report.tests.filter(
      (t) => t.status !== "passed" && t.status !== "skipped"
    )
    const messages = [...report.errors, ...failed.map((t) => t.error ?? "")]
    const joined = messages.join("\n")
    // QA's own spec doesn't load, or selects nothing.
    if (TEST_DEFECT.test(joined))
      return { class: "test_defect", signal: firstLine(joined, TEST_DEFECT) }
    // Nothing ran and the run itself errored: the spec, unless the error is
    // the app being unreachable.
    if (!report.tests.length && report.errors.length)
      return BROWSER_NETWORK.test(joined)
        ? { class: "environment", signal: firstLine(joined, BROWSER_NETWORK) }
        : { class: "test_defect", signal: firstLine(joined, /\S/) }
    if (!report.tests.length && /No tests found/i.test(evidence.logTail ?? ""))
      return { class: "test_defect", signal: "No tests found" }
    // The browser couldn't reach the app before any assertion ran.
    const unreachable = failed.find(
      (t) =>
        BROWSER_NETWORK.test(t.error ?? "") && !ASSERTION.test(t.error ?? "")
    )
    if (unreachable)
      return {
        class: "environment",
        signal: firstLine(unreachable.error ?? "", BROWSER_NETWORK),
      }
    const asserted = failed.find((t) => ASSERTION.test(t.error ?? ""))
    if (asserted)
      return evidence.smokeVerified
        ? {
            class: "feature",
            signal: firstLine(asserted.error ?? "", ASSERTION),
          }
        : {
            class: "environment",
            signal:
              "an assertion failed against an app that never passed smoke",
          }
  }

  // Tiebreakers from the output.
  const log = evidence.logTail ?? ""
  if (MISSING_ENV.test(log))
    return { class: "environment", signal: firstLine(log, MISSING_ENV) }
  if (!evidence.smokeVerified && ENVIRONMENT_LOG.test(log))
    return { class: "environment", signal: firstLine(log, ENVIRONMENT_LOG) }

  // Unknown: before the app was shown to run it's the environment's to fix;
  // after, it's the feature's.
  return evidence.smokeVerified
    ? { class: "feature", signal: "unclassified failure after smoke passed" }
    : {
        class: "environment",
        signal: "unclassified failure before smoke passed",
      }
}

function firstLine(text: string, pattern: RegExp): string {
  const line =
    text.split("\n").find((l) => pattern.test(l)) ?? text.split("\n")[0] ?? ""
  return line.trim().slice(0, 200)
}
