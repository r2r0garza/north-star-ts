import type { Evidence } from "../../../shared/mission-control/workspace-analysis"
import type { TestBrowserState } from "../playwright-install"
import type { FindingDraft } from "./draft"

// The test browser finding (plan 112.1, ported from backup:109.06): a rig
// with a QA seat runs Playwright, and that needs a browser. In plan 112's
// order: the workspace's own Playwright browser when it's installed, else the
// user's Google Chrome, else Playwright's headless shell downloaded into app
// data once, with the user's consent. Unlike the other findings this one is
// about the machine, not the workspace, so it's computed live on every read
// instead of stored with the analysis: a download started from Settings or
// another feature resolves it everywhere.

export const TEST_BROWSER_FINDING = "app-launch:test-browser"

export interface WorkspaceBrowser {
  // The workspace's `@playwright/test` version.
  version: string
  installed: boolean
  // Where its Chromium lives (or would), when known.
  location: string | null
}

export interface TestBrowserFacts {
  // The rig has a QA seat: its runs need a browser.
  qaSeat: boolean
  // The workspace's own Playwright, or null when it has none (the bundled
  // runner is used). Undefined while it hasn't been probed yet.
  workspace: WorkspaceBrowser | null | undefined
  bundled: TestBrowserState
}

const CHROME_DOWNLOAD = "https://www.google.com/chrome/"
const TITLE_OK = "QA's browser checks have a browser"

function chromeAlternative(): FindingDraft["fix"] {
  return {
    kind: "manual",
    summary: "Install Google Chrome instead",
    steps: [
      "Install Google Chrome.",
      "Analyze again: QA's checks use it, and nothing is downloaded.",
    ],
    link: CHROME_DOWNLOAD,
  }
}

function projectBrowserAlternative(): FindingDraft["fix"] {
  return {
    kind: "run-command",
    summary:
      "Install the project's own Playwright browser instead (once per Playwright version)",
    commands: [
      {
        label: "Install Playwright's Chromium",
        command: "npx playwright install chromium",
        cwd: "",
      },
    ],
    verify: [],
  }
}

function projectEvidence(
  browser: WorkspaceBrowser
): Array<Omit<Evidence, "id">> {
  return [
    {
      kind: "manifest",
      label: `The project has its own @playwright/test ${browser.version}; QA's checks run on it`,
    },
    ...(browser.location
      ? [
          {
            kind: "probe" as const,
            label: browser.installed
              ? "Its Chromium is installed"
              : "Its Chromium isn't installed",
            detail: browser.location,
          },
        ]
      : []),
  ]
}

export function testBrowserDraft(facts: TestBrowserFacts): FindingDraft | null {
  if (!facts.qaSeat || facts.workspace === undefined) return null
  const { bundled, workspace } = facts
  const base = {
    key: TEST_BROWSER_FINDING,
    category: "app-launch" as const,
    severity: "blocker" as const,
    confidence: "verified" as const,
    source: "probe" as const,
  }
  const download: FindingDraft["fix"] = {
    kind: "download-test-browser",
    summary: `Download Playwright's test browser (${bundled.sizeMb ? `about ${Math.round(bundled.sizeMb)} MB` : "about 100 MB"}) into North Star's app data, once`,
    sizeMb: bundled.sizeMb,
  }
  const own = workspace ? projectEvidence(workspace) : []

  // 1. The project's own Playwright browser.
  if (workspace?.installed)
    return {
      ...base,
      title: TITLE_OK,
      explanation: `QA's Playwright checks use the project's Playwright ${workspace.version} and its Chromium, which is installed.`,
      evidence: own,
      fix: download,
      resolution: "Project's Playwright browser installed",
    }
  switch (bundled.status) {
    case "unknown":
      return null
    // 2. The user's Chrome, for either Playwright.
    case "chrome":
      return {
        ...base,
        title: TITLE_OK,
        explanation: workspace
          ? `The project's Playwright ${workspace.version} has no browser installed, so QA's checks use your installed Google Chrome. Nothing to download.`
          : "QA's Playwright checks use your installed Google Chrome. Nothing to download.",
        evidence: [
          ...own,
          { kind: "probe", label: "Google Chrome is installed" },
        ],
        fix: download,
        resolution: "Uses your Google Chrome",
      }
    // 3. The downloaded headless shell. A project Playwright of another
    // version fetches its own matching one on first use, without asking.
    case "installed":
      return {
        ...base,
        title: TITLE_OK,
        explanation:
          "QA's Playwright checks use Playwright's test browser, already downloaded into North Star's app data.",
        evidence: [
          ...own,
          { kind: "probe", label: "The test browser is installed in app data" },
        ],
        fix: download,
        resolution: "Test browser installed",
      }
    case "unavailable":
      if (workspace) break
      return {
        ...base,
        title: "QA can't run its browser checks: Playwright is missing",
        explanation:
          "The project has no @playwright/test and North Star's bundled copy is missing, so QA's Playwright checks can't run. Reinstalling North Star restores it.",
        evidence: [
          { kind: "probe", label: "No bundled @playwright/test was found" },
        ],
        fix: {
          kind: "manual",
          summary: "Reinstall North Star",
          steps: ["Reinstall North Star, then analyze again."],
        },
      }
  }
  return {
    ...base,
    title: "QA can't run its browser checks: no browser on this computer",
    explanation:
      "This rig has a QA seat, and its Playwright checks need a browser. There's no Google Chrome on this computer and Playwright's test browser hasn't been downloaded, so QA would have to wait for one. Downloading it once covers every feature; later Playwright updates fetch their matching browser without asking again.",
    evidence: [
      ...own,
      { kind: "probe", label: "Google Chrome isn't installed" },
      {
        kind: "probe",
        label:
          bundled.status === "downloading"
            ? "The test browser is downloading"
            : "The test browser isn't in North Star's app data",
        ...(bundled.status === "failed" && bundled.error
          ? { detail: `The last download failed: ${bundled.error}` }
          : {}),
      },
    ],
    fix: download,
    alternatives: [
      chromeAlternative(),
      ...(workspace ? [projectBrowserAlternative()] : []),
    ],
  }
}
