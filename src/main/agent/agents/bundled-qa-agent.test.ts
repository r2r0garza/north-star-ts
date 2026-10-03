import { describe, expect, it } from "vitest"
import { readFileSync } from "fs"
import path from "path"

// The bundled QA agent (plan 109.01): QA writes and runs its own checks, only
// in its checks directory, and never edits product code. Seeding and refresh
// of user copies is covered by config/bundled-seed.test.ts.
const prompt = readFileSync(
  path.join(__dirname, "../../../../agents/qa-agent.agent.md"),
  "utf8"
)

describe("bundled QA agent", () => {
  it("writes and runs checks but never edits product code", () => {
    expect(prompt).toMatch(
      /You write and run checks\. You never edit product code/
    )
    expect(prompt).not.toMatch(/you verify and report; you do not fix/i)
  })

  it("explains the checks directory and why other writes are refused", () => {
    expect(prompt).toMatch(/checks directory/)
    expect(prompt).toMatch(/refuse writes anywhere else, on purpose/)
  })

  it("organizes checks as shared test code instead of duplicating them", () => {
    expect(prompt).toMatch(/page object pattern/)
    expect(prompt).toMatch(/Reuse existing page objects and helpers/)
  })

  it("keeps the adversarial mindset and the unverified-items rule", () => {
    expect(prompt).toMatch(
      /Assume it's broken until the evidence says otherwise/
    )
    expect(prompt).toMatch(/what you could NOT verify/)
  })

  it("describes the seat browser workflow (plan 109.04)", () => {
    expect(prompt).toMatch(/Start the app first \(`app_start`/)
    expect(prompt).toMatch(/Call `browser_snapshot` before you interact/)
    expect(prompt).toMatch(/save_evidence: true/)
    expect(prompt).toMatch(/only opens local apps/)
  })

  it("says each criterion records how it was verified (plan 109.05)", () => {
    expect(prompt).toMatch(
      /In a Mission Control proof that's each criterion's `method`/
    )
    expect(prompt).toMatch(/reading code is never "met"/)
  })

  it("doesn't mention tools later slices add", () => {
    expect(prompt).not.toContain("run_checks")
  })
})
