import { describe, expect, it } from "vitest"
import {
  automatedChecks,
  DEFAULT_CHECK_TIMEOUT_MS,
  validateChecksManifest,
} from "./checks-manifest"

const storyRef = "billing.m1.login"
const criterionIds = ["AC-1", "AC-2"]

function validate(manifest: unknown, servicesAvailable = false) {
  return validateChecksManifest({
    text: typeof manifest === "string" ? manifest : JSON.stringify(manifest),
    criterionIds,
    storyRef,
    servicesAvailable,
  })
}

const good = {
  criteria: {
    "AC-1": [
      {
        id: "ac1-login-redirect",
        kind: "automated",
        command: `npx playwright test --grep "@${storyRef}.*@AC-1"`,
        cwd: "./",
        timeoutMs: 120000,
      },
    ],
    "AC-2": [{ id: "ac2-copy", kind: "exploratory", note: "Check the copy" }],
  },
}

describe("validateChecksManifest", () => {
  it("accepts a good manifest and normalizes it", () => {
    const result = validate(good)
    expect(result).toEqual({
      ok: true,
      warnings: [],
      manifest: {
        criteria: {
          "AC-1": [
            {
              id: "ac1-login-redirect",
              kind: "automated",
              command: `npx playwright test --grep "@${storyRef}.*@AC-1"`,
              cwd: "",
              services: [],
              timeoutMs: 120000,
            },
          ],
          "AC-2": [
            { id: "ac2-copy", kind: "exploratory", note: "Check the copy" },
          ],
        },
      },
    })
    if (result.ok)
      expect(
        automatedChecks(result.manifest).map((c) => c.criterionId)
      ).toEqual(["AC-1"])
  })

  it("defaults the timeout and accepts lower-case criterion ids", () => {
    const result = validate({
      criteria: {
        "ac-1": [
          { id: "a", kind: "automated", command: `x --grep @${storyRef}` },
        ],
        "AC-2": [{ id: "b", kind: "exploratory", note: "n" }],
      },
    })
    expect(result.ok).toBe(true)
    if (result.ok)
      expect(result.manifest.criteria["AC-1"][0]).toMatchObject({
        timeoutMs: DEFAULT_CHECK_TIMEOUT_MS,
      })
  })

  it("rejects invalid JSON and a missing criteria object", () => {
    expect(validate("{nope").ok).toBe(false)
    expect(validate({ checks: [] })).toMatchObject({ ok: false })
  })

  it("rejects duplicate check ids", () => {
    const result = validate({
      criteria: {
        "AC-1": [{ id: "dup", kind: "exploratory", note: "a" }],
        "AC-2": [{ id: "dup", kind: "exploratory", note: "b" }],
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.errors.join(" ")).toMatch(/"dup" is used more than once/)
  })

  it("rejects an unknown criterion and a missing one", () => {
    const result = validate({
      criteria: {
        "AC-1": good.criteria["AC-1"],
        "AC-9": good.criteria["AC-2"],
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.join(" ")).toMatch(/"AC-9" is not one of/)
      expect(result.errors.join(" ")).toMatch(/missing: AC-2/)
    }
  })

  it("rejects an automated check without a command", () => {
    const result = validate({
      criteria: {
        "AC-1": [{ id: "a", kind: "automated" }],
        "AC-2": good.criteria["AC-2"],
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.errors).toContain('Automated check "a" needs a "command".')
  })

  it("rejects a cwd that escapes the workspace", () => {
    for (const cwd of ["../other", "/tmp", "a/../../b", "C:\\x"]) {
      const result = validate({
        criteria: {
          "AC-1": [{ id: "a", kind: "automated", command: "x a.spec.ts", cwd }],
          "AC-2": good.criteria["AC-2"],
        },
      })
      expect(result.ok, cwd).toBe(false)
    }
  })

  it("refuses services until a launch recipe exists", () => {
    const manifest = {
      criteria: {
        "AC-1": [{ ...good.criteria["AC-1"][0], services: ["web"] }],
        "AC-2": good.criteria["AC-2"],
      },
    }
    const refused = validate(manifest)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.errors[0]).toMatch(/no app launch recipe/)
    expect(validate(manifest, true).ok).toBe(true)
  })

  it("warns when a command selects neither the story tag nor a file", () => {
    const result = validate({
      criteria: {
        "AC-1": [
          { id: "a", kind: "automated", command: "npx playwright test" },
        ],
        "AC-2": [
          {
            id: "b",
            kind: "automated",
            command: "node e2e/specs/login.spec.mjs",
          },
        ],
      },
    })
    expect(result.ok).toBe(true)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatch(/Check "a" doesn't select/)
  })
})
