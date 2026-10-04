import { describe, expect, it } from "vitest"
import {
  automatedChecks,
  DEFAULT_CHECK_TIMEOUT_MS,
  localImports,
  unreachableAppProblem,
  validateChecksManifest,
} from "./checks-manifest"

const storyRef = "billing.m1.login"
const criterionIds = ["AC-1", "AC-2"]

function validate(manifest: unknown, serviceKeys: string[] = []) {
  return validateChecksManifest({
    text: typeof manifest === "string" ? manifest : JSON.stringify(manifest),
    criterionIds,
    storyRef,
    serviceKeys,
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
              runner: "command",
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

  it("accepts only services from the launch recipe", () => {
    const manifest = {
      criteria: {
        "AC-1": [{ ...good.criteria["AC-1"][0], services: ["web"] }],
        "AC-2": good.criteria["AC-2"],
      },
    }
    const refused = validate(manifest)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.errors[0]).toMatch(/no app launch recipe/)
    const unknown = validate(manifest, ["api"])
    expect(unknown.ok).toBe(false)
    if (!unknown.ok)
      expect(unknown.errors[0]).toMatch(/aren't in the app launch recipe: web/)
    expect(validate(manifest, ["web", "api"]).ok).toBe(true)
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

  describe("Playwright checks", () => {
    const playwright = (check: Record<string, unknown>) =>
      validate(
        {
          criteria: {
            "AC-1": [
              {
                id: "ac1-login-redirect",
                kind: "automated",
                runner: "playwright",
                ...check,
              },
            ],
            "AC-2": [{ id: "ac2-copy", kind: "exploratory", note: "Copy" }],
          },
        },
        ["web"]
      )

    it("accepts a spec, grep, and services", () => {
      const result = playwright({
        spec: "./auth/login.spec.ts",
        grep: "redirects to dashboard",
        services: ["web"],
      })
      expect(result.ok && result.manifest.criteria["AC-1"]).toEqual([
        {
          id: "ac1-login-redirect",
          kind: "automated",
          runner: "playwright",
          spec: "auth/login.spec.ts",
          grep: "redirects to dashboard",
          cwd: "",
          services: ["web"],
          timeoutMs: DEFAULT_CHECK_TIMEOUT_MS,
        },
      ])
      expect(result.warnings).toEqual([])
    })

    it("rejects a command alongside the runner", () => {
      const result = playwright({
        spec: "login.spec.ts",
        command: "npx playwright test",
      })
      expect(result.ok).toBe(false)
      if (!result.ok)
        expect(result.errors[0]).toMatch(/can't also have a "command"/)
    })

    it("rejects a missing spec and one outside the checks directory", () => {
      for (const [spec, message] of [
        [undefined, /needs a "spec"/],
        ["../src/app.spec.ts", /outside the checks directory/],
        ["/abs/login.spec.ts", /outside the checks directory/],
      ] as const) {
        const result = playwright(spec === undefined ? {} : { spec })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.errors[0]).toMatch(message)
      }
    })

    it("rejects a grep that isn't a regular expression, and an unknown runner", () => {
      const bad = playwright({ spec: "login.spec.ts", grep: "(" })
      expect(!bad.ok && bad.errors[0]).toMatch(/isn't a regular expression/)
      const unknown = playwright({ runner: "cypress", spec: "login.cy.ts" })
      expect(!unknown.ok && unknown.errors[0]).toMatch(/unknown "runner"/)
    })
  })
})

describe("unreachableAppProblem (plan 109.07)", () => {
  const problem = (specText: string, helperTexts: string[] = []) =>
    unreachableAppProblem({
      id: "ac1",
      spec: "a.spec.ts",
      specText,
      helperTexts,
    })

  it("flags hard-coded ports, the recipe's variables, and relative navigation without a baseURL", () => {
    expect(problem('await page.goto("http://localhost:3000/")')).toMatch(
      /uses localhost:3000/
    )
    expect(problem("const base = process.env.APP_WEB_URL")).toMatch(
      /reads process\.env\.APP_WEB_URL/
    )
    expect(problem('await page.goto("/")')).toMatch(/relative path/)
    expect(problem("await request.get('/api/items')")).toMatch(/relative path/)
  })

  it("accepts a fixture that provides baseURL, and specs that never navigate", () => {
    expect(
      problem('await page.goto("/")', [
        "export const test = base.extend({ baseURL: async ({}, use) => use(url) })",
      ])
    ).toBeNull()
    expect(
      problem('test.use({ baseURL: url })\nawait page.goto("/")')
    ).toBeNull()
    expect(
      problem("const app = await _electron.launch({ args: ['.'] })")
    ).toBeNull()
    expect(problem("const url = `http://127.0.0.1:${port}`")).toBeNull()
  })

  it("lists a source's relative imports", () => {
    expect(
      localImports(
        'import { test } from "../fixtures/app"\nimport x from "@playwright/test"\nconst y = require("./helpers.cjs")\nimport "./setup"'
      )
    ).toEqual(["../fixtures/app", "./helpers.cjs", "./setup"])
  })
})
