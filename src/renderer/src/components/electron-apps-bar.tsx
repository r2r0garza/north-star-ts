import * as React from "react"
import { AppWindow, Square } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { CoworkApi } from "../../../preload/index"

type ElectronAppSession = Awaited<
  ReturnType<CoworkApi["electronApps"]["list"]>
>[number]

const LIVE = new Set(["launching", "ready", "closing"])

// Host-owned surface for agent-launched Electron apps (plan 119): which apps
// are running, under which profile, and a Stop that does not depend on the
// agent. Hidden while nothing is live.
export function ElectronAppsBar() {
  const [sessions, setSessions] = React.useState<ElectronAppSession[]>([])
  React.useEffect(() => {
    void window.cowork.electronApps.list().then(setSessions)
    return window.cowork.electronApps.onChanged(setSessions)
  }, [])
  const live = sessions.filter((s) => LIVE.has(s.state))
  if (live.length === 0) return null
  return (
    <div
      role="region"
      aria-label="Running test apps"
      className="fixed bottom-3 left-1/2 z-50 flex -translate-x-1/2 flex-col gap-1"
    >
      {live.map((s) => (
        <div
          key={s.sessionId}
          className="flex items-center gap-2 rounded-md border bg-background/95 px-3 py-1.5 text-xs shadow-md"
        >
          <AppWindow className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="max-w-64 truncate font-medium" title={s.entry}>
            {s.entry}
          </span>
          <span className="text-muted-foreground">
            {s.isolation === "north-star-test-profile"
              ? "test profile"
              : "disposable userData"}
            {" · "}
            {s.windows.length} window{s.windows.length === 1 ? "" : "s"}
            {" · "}
            {s.state}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs"
            disabled={s.state === "closing"}
            onClick={() => void window.cowork.electronApps.stop(s.sessionId)}
          >
            <Square className="size-3" />
            Stop
          </Button>
        </div>
      ))}
    </div>
  )
}
