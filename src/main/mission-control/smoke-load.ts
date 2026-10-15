import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import type { SmokeBrowserLoad, SmokePageResult } from "./app-launch"
import { runPlaywright } from "./playwright-runner"

// The smoke stage's browser load (plan 112.3): one generated test on the
// 112.1 Playwright runner that loads each smoke URL headless, with the
// resolved test browser, and records console errors and failed requests.
// The spec and its output live in a temp directory, never the workspace.
// `112.4` may swap in the seat browser if the scorecard shows a difference.

const SPEC = `import { test } from "@playwright/test"
import { writeFileSync } from "node:fs"

const urls = JSON.parse(process.env.NORTH_STAR_SMOKE_URLS || "[]")
const clip = (text) => String(text).split("\\n")[0].slice(0, 300)

test("smoke", async ({ page }) => {
  const results = []
  for (const url of urls) {
    const consoleErrors = []
    const failedRequests = []
    const onConsole = (m) => { if (m.type() === "error") consoleErrors.push(clip(m.text())) }
    const onPageError = (e) => consoleErrors.push(clip(e && e.message ? e.message : e))
    const onFailed = (r) => {
      const why = r.failure() ? r.failure().errorText : "failed"
      // A navigation the page itself aborted isn't a failure of the app.
      if (why === "net::ERR_ABORTED") return
      failedRequests.push(clip(r.method() + " " + r.url() + " " + why))
    }
    const onResponse = (r) => {
      if (r.status() >= 500) failedRequests.push(clip(r.request().method() + " " + r.url() + " → " + r.status()))
    }
    page.on("console", onConsole)
    page.on("pageerror", onPageError)
    page.on("requestfailed", onFailed)
    page.on("response", onResponse)
    let error = null
    try {
      const res = await page.goto(url, { waitUntil: "load", timeout: 30000 })
      if (res && res.status() >= 500) error = "status " + res.status()
      await page.waitForTimeout(500)
    } catch (e) {
      error = clip(e && e.message ? e.message : e)
    }
    page.off("console", onConsole)
    page.off("pageerror", onPageError)
    page.off("requestfailed", onFailed)
    page.off("response", onResponse)
    results.push({ url, error, consoleErrors, failedRequests })
  }
  writeFileSync(process.env.NORTH_STAR_SMOKE_OUT, JSON.stringify(results))
})
`

const SMOKE_TIMEOUT_MS = 3 * 60_000

export const playwrightSmokeLoad: SmokeBrowserLoad = async ({
  urls,
  cwd,
  signal,
}) => {
  const dir = await mkdtemp(join(tmpdir(), "north-star-smoke-"))
  try {
    const testDir = join(dir, "tests")
    const out = join(dir, "results.json")
    await mkdir(testDir, { recursive: true })
    await writeFile(join(testDir, "smoke.spec.mjs"), SPEC)
    const run = await runPlaywright({
      cwd,
      testDir,
      testMatch: ["smoke.spec.mjs"],
      baseURL: null,
      env: {
        NORTH_STAR_SMOKE_URLS: JSON.stringify(urls),
        NORTH_STAR_SMOKE_OUT: out,
      },
      outputDir: join(dir, "output"),
      timeoutMs: SMOKE_TIMEOUT_MS,
      signal,
    })
    if (run.notVerifiable) return { notVerifiable: run.notVerifiable }
    let pages: SmokePageResult[] | null = null
    try {
      pages = JSON.parse(await readFile(out, "utf8")) as SmokePageResult[]
    } catch {
      pages = null
    }
    if (pages) return { pages }
    // The test never got to write its results: the browser couldn't run the
    // load at all, which is not the app's fault either way.
    return {
      notVerifiable: `the smoke browser load didn't run (${run.timedOut ? "timed out" : (run.tests[0]?.error ?? run.output.trim().split("\n").at(-1) ?? "no output")})`,
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
