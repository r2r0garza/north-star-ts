import { useEffect, useState } from "react"
import { Download } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field"
import { Progress } from "@/components/ui/progress"
import type { TestBrowserState } from "@/types"

// The test browser QA's Playwright checks use when there's no Chrome (plan
// 109.06). Downloading it is an outbound download, so it only happens when
// the user clicks: from the Mission Control notice a check raised, or from
// Settings → General → Browser. Consent is remembered after that.

export function useTestBrowser(): {
  state: TestBrowserState | null
  install: () => void
} {
  const [state, setState] = useState<TestBrowserState | null>(null)
  useEffect(() => {
    let live = true
    window.cowork.missionControl.testBrowser
      .get()
      .then((s) => live && setState(s))
      .catch(() => {})
    const off = window.cowork.missionControl.testBrowser.onChanged(setState)
    return () => {
      live = false
      off()
    }
  }, [])
  return {
    state,
    install: () => {
      void window.cowork.missionControl.testBrowser.install()
    },
  }
}

function size(state: TestBrowserState): string {
  return state.sizeMb ? `about ${Math.round(state.sizeMb)} MB` : "about 100 MB"
}

function DownloadProgress({ state }: { state: TestBrowserState }) {
  const percent = state.progress?.percent ?? 0
  const total = state.progress?.totalMb
  return (
    <div className="flex flex-col gap-1.5">
      <Progress value={percent} />
      <span className="text-xs text-muted-foreground">
        Downloading… {percent}%{total ? ` of ${Math.round(total)} MB` : ""}
      </span>
    </div>
  )
}

// Under the workspace checklist's test browser finding: the download's
// progress, or why the last one failed.
export function TestBrowserFixStatus() {
  const { state } = useTestBrowser()
  if (state?.status === "downloading") return <DownloadProgress state={state} />
  if (state?.status === "failed" && state.error)
    return (
      <p className="text-xs text-destructive">
        The last download failed: {state.error}
      </p>
    )
  return null
}

// Shown in Mission Control when a QA check needed a browser and none is
// installed: those checks are not verifiable until the user allows this.
export function TestBrowserNotice() {
  const { state, install } = useTestBrowser()
  if (!state?.requested) return null
  if (!["missing", "failed", "downloading"].includes(state.status)) return null
  return (
    <div className="border-b px-6 py-3">
      <Alert>
        <Download />
        <AlertTitle>QA needs a browser to run its Playwright checks</AlertTitle>
        <AlertDescription>
          <p>
            There's no Google Chrome on this computer, so the checks that drive
            a browser can't run and are recorded as not verifiable. North Star
            can download Playwright's test browser ({size(state)}) into its own
            app data, once. Later Playwright updates fetch their matching
            browser without asking again.
          </p>
          {state.status === "downloading" ? (
            <DownloadProgress state={state} />
          ) : (
            <div className="flex items-center gap-3">
              <Button size="sm" onClick={install}>
                Download test browser
              </Button>
              {state.status === "failed" && state.error && (
                <span className="text-xs text-destructive">
                  The last download failed: {state.error}
                </span>
              )}
            </div>
          )}
        </AlertDescription>
      </Alert>
    </div>
  )
}

// Settings → General → Browser.
export function TestBrowserSetting() {
  const { state, install } = useTestBrowser()
  if (!state || state.status === "unavailable") return null
  const description =
    state.status === "chrome"
      ? "QA's Playwright checks use your installed Google Chrome. Nothing to download."
      : state.status === "installed"
        ? "Installed in North Star's app data. QA's Playwright checks use it when there's no Google Chrome."
        : `QA's Playwright checks need a browser, and there's no Google Chrome on this computer. Download Playwright's test browser (${size(state)}) into North Star's app data, once; later updates fetch their matching browser automatically.`
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel>Test browser for QA checks</FieldLabel>
        <FieldDescription>{description}</FieldDescription>
        {state.status === "downloading" && <DownloadProgress state={state} />}
        {state.status === "failed" && state.error && (
          <span className="text-xs text-destructive">
            The last download failed: {state.error}
          </span>
        )}
      </FieldContent>
      {(state.status === "missing" || state.status === "failed") && (
        <Button size="sm" variant="outline" onClick={install}>
          {state.status === "failed" ? "Retry download" : "Download"}
        </Button>
      )}
    </Field>
  )
}
