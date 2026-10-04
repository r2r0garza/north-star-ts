import { describe, expect, it } from "vitest"
import type { TestBrowserState } from "../playwright-install"
import { TEST_BROWSER_FINDING, testBrowserDraft } from "./test-browser"

const bundled = (patch: Partial<TestBrowserState> = {}): TestBrowserState => ({
  status: "missing",
  requested: false,
  consent: false,
  progress: null,
  sizeMb: null,
  error: null,
  ...patch,
})

describe("testBrowserDraft", () => {
  it("makes nothing without a QA seat, or before the workspace is probed", () => {
    expect(
      testBrowserDraft({ qaSeat: false, workspace: null, bundled: bundled() })
    ).toBeNull()
    expect(
      testBrowserDraft({
        qaSeat: true,
        workspace: undefined,
        bundled: bundled(),
      })
    ).toBeNull()
    expect(
      testBrowserDraft({
        qaSeat: true,
        workspace: null,
        bundled: bundled({ status: "unknown" }),
      })
    ).toBeNull()
  })

  it("blocks with a download (and Chrome by hand) when there's no browser", () => {
    const draft = testBrowserDraft({
      qaSeat: true,
      workspace: null,
      bundled: bundled({ status: "failed", error: "offline", sizeMb: 91.6 }),
    })!
    expect(draft).toMatchObject({
      key: TEST_BROWSER_FINDING,
      category: "app-launch",
      severity: "blocker",
      fix: { kind: "download-test-browser", sizeMb: 91.6 },
      alternatives: [
        { kind: "manual", link: "https://www.google.com/chrome/" },
      ],
    })
    expect(draft.resolution).toBeUndefined()
    expect(draft.fix.summary).toMatch(/about 92 MB/)
    expect(draft.evidence[1].detail).toMatch(/offline/)
  })

  it("resolves with Chrome or a downloaded browser", () => {
    expect(
      testBrowserDraft({
        qaSeat: true,
        workspace: null,
        bundled: bundled({ status: "chrome" }),
      })?.resolution
    ).toBe("Uses your Google Chrome")
    expect(
      testBrowserDraft({
        qaSeat: true,
        workspace: null,
        bundled: bundled({ status: "installed" }),
      })?.resolution
    ).toBe("Test browser installed")
  })

  it("checks the project's own Playwright browser instead of the bundled one", () => {
    const missing = testBrowserDraft({
      qaSeat: true,
      workspace: { version: "1.63.0", installed: false, location: "/c/x" },
      bundled: bundled({ status: "chrome" }),
    })!
    expect(missing.resolution).toBeUndefined()
    expect(missing.fix).toMatchObject({
      kind: "run-command",
      commands: [{ command: "npx playwright install chromium", cwd: "" }],
    })
    const installed = testBrowserDraft({
      qaSeat: true,
      workspace: { version: "1.63.0", installed: true, location: "/c/x" },
      bundled: bundled(),
    })!
    expect(installed.resolution).toBe("Project's Playwright browser installed")
  })
})
