import type { Evidence } from "../../../shared/mission-control/workspace-analysis"
import type { TestBrowserState } from "../playwright-install"
import type { FindingDraft } from "./draft"

// The test browser finding (plan 109.06): a rig with a QA seat runs
// Playwright checks, and those need a browser. The workspace's own
// `@playwright/test` uses its own browsers (Playwright's cache); otherwise
// the bundled runner uses the user's Google Chrome, or Playwright's headless
// shell downloaded into app data once, with the user's consent. Unlike the
// other findings this one is about the machine, not the workspace, so it's
// computed live on every read instead of stored with the analysis: a download
// started from Settings or another feature resolves it everywhere.

export const TEST_BROWSER_FINDING = "app-launch:test-browser"

export interface WorkspaceBrowser {
  // The workspace's `@playwright/test` version.
  version: string
  installed: boolean
  // Where its Chromium lives (or would), when known.
  location: string | null
}

export interface TestBrowserFacts {
  // The rig has a QA seat: its checks need a browser.
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

function workspaceDraft(browser: WorkspaceBrowser): FindingDraft {
  const evidence: Array<Omit<Evidence, "id">> = [
    {
      kind: "manifest",
      label: `The project has its own @playwright/test ${browser.version}; QA's checks run on it, with its own browsers`,
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
  const fix: FindingDraft["fix"] = {
    kind: "run-command",
    summary:
      "Install the project's Playwright browser (once per Playwright version)",
    commands: [
      {
        label: "Install Playwright's Chromium",
        command: "npx playwright install chromium",
        cwd: "",
      },
    ],
    verify: [],
  }
  if (browser.installed)
    return {
      key: TEST_BROWSER_FINDING,
      category: "app-launch",
      severity: "blocker",
      title: TITLE_OK,
      explanation: `QA's Playwright checks use the project's Playwright ${browser.version} and its Chromium, which is installed.`,
      evidence,
      confidence: "verified",
      source: "probe",
      fix,
      resolution: "Project's Playwright browser installed",
    }
  return {
    key: TEST_BROWSER_FINDING,
    category: "app-launch",
    severity: "blocker",
    title:
      "QA can't run its browser checks: Playwright's browser isn't installed",
    explanation: `This rig has a QA seat, and its checks run on the project's Playwright ${browser.version}, whose Chromium isn't installed on this computer. Until it is, every browser check is recorded as not verifiable.`,
    evidence,
    confidence: "verified",
    source: "probe",
    fix,
  }
}

export function testBrowserDraft(facts: TestBrowserFacts): FindingDraft | null {
  if (!facts.qaSeat || facts.workspace === undefined) return null
  if (facts.workspace) return workspaceDraft(facts.workspace)
  const { bundled } = facts
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
  switch (bundled.status) {
    case "unknown":
      return null
    case "chrome":
      return {
        ...base,
        title: TITLE_OK,
        explanation:
          "QA's Playwright checks use your installed Google Chrome. Nothing to download.",
        evidence: [{ kind: "probe", label: "Google Chrome is installed" }],
        fix: download,
        resolution: "Uses your Google Chrome",
      }
    case "installed":
      return {
        ...base,
        title: TITLE_OK,
        explanation:
          "QA's Playwright checks use Playwright's test browser, already downloaded into North Star's app data.",
        evidence: [
          { kind: "probe", label: "The test browser is installed in app data" },
        ],
        fix: download,
        resolution: "Test browser installed",
      }
    case "unavailable":
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
    default:
      return {
        ...base,
        title: "QA can't run its browser checks: no browser on this computer",
        explanation:
          "This rig has a QA seat, and its Playwright checks need a browser. There's no Google Chrome on this computer and Playwright's test browser hasn't been downloaded, so every browser check would be recorded as not verifiable. Downloading it once covers every feature; later Playwright updates fetch their matching browser without asking again.",
        evidence: [
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
        alternatives: [chromeAlternative()],
      }
  }
}
