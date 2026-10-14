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

  it("prefers the project's own Playwright browser, then Chrome, then the download", () => {
    const project = (installed: boolean) => ({
      version: "1.63.0",
      installed,
      location: "/c/x",
    })
    expect(
      testBrowserDraft({
        qaSeat: true,
        workspace: project(true),
        bundled: bundled(),
      })?.resolution
    ).toBe("Project's Playwright browser installed")
    // The project's Playwright without its browser uses Chrome.
    const chrome = testBrowserDraft({
      qaSeat: true,
      workspace: project(false),
      bundled: bundled({ status: "chrome" }),
    })!
    expect(chrome.resolution).toBe("Uses your Google Chrome")
    expect(chrome.explanation).toMatch(
      /project's Playwright 1\.63\.0 has no browser/
    )
    // Neither: the download, with Chrome or the project's own install by hand.
    const missing = testBrowserDraft({
      qaSeat: true,
      workspace: project(false),
      bundled: bundled({ status: "missing" }),
    })!
    expect(missing.resolution).toBeUndefined()
    expect(missing.fix.kind).toBe("download-test-browser")
    expect(missing.alternatives).toMatchObject([
      { kind: "manual" },
      {
        kind: "run-command",
        commands: [{ command: "npx playwright install chromium", cwd: "" }],
      },
    ])
  })
})
