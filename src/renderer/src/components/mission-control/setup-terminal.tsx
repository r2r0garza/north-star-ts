import { useEffect, useRef } from "react"
import { FitAddon } from "@xterm/addon-fit"
import { Terminal as XtermTerminal } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"

// The Workspace setup terminal (plan 106.11): each command a setup run starts
// is its own integrated-terminal session. This shows one session's live
// output and forwards keystrokes, so the user can answer a prompt (a
// password, a confirmation). Output is buffered from the moment a session is
// seen, so switching between steps replays it.

const MAX_BUFFER = 200_000
const buffers = new Map<string, string>()
const listeners = new Map<string, Set<(data: string) => void>>()
let subscribed = false

function ensureSubscribed() {
  if (subscribed) return
  subscribed = true
  window.cowork.terminal.onData(({ id, data }) => {
    const next = (buffers.get(id) ?? "") + data
    buffers.set(id, next.length > MAX_BUFFER ? next.slice(-MAX_BUFFER) : next)
    listeners.get(id)?.forEach((cb) => cb(data))
  })
}

// Start buffering before any session exists, so a run's first output isn't
// lost while the renderer learns the session id.
export function watchSetupOutput() {
  ensureSubscribed()
}

export function SetupTerminal({
  sessionId,
  interactive,
}: {
  sessionId: string
  // Keystrokes reach the process only while it's running.
  interactive: boolean
}) {
  const host = useRef<HTMLDivElement | null>(null)
  const interactiveRef = useRef(interactive)
  interactiveRef.current = interactive
  useEffect(() => {
    ensureSubscribed()
    if (!host.current) return
    const term = new XtermTerminal({
      convertEol: true,
      fontSize: 12,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      scrollback: 5000,
      theme: { background: "#0b0b0c" },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current)
    const resize = () => {
      try {
        fit.fit()
        if (interactiveRef.current)
          void window.cowork.terminal
            .resize(sessionId, term.cols, term.rows)
            .catch(() => {})
      } catch {
        // not laid out yet
      }
    }
    resize()
    term.write(buffers.get(sessionId) ?? "")
    const onData = (data: string) => term.write(data)
    if (!listeners.has(sessionId)) listeners.set(sessionId, new Set())
    listeners.get(sessionId)!.add(onData)
    const input = term.onData((data) => {
      if (interactiveRef.current)
        void window.cowork.terminal.write(sessionId, data).catch(() => {})
    })
    const observer = new ResizeObserver(resize)
    observer.observe(host.current)
    return () => {
      observer.disconnect()
      input.dispose()
      listeners.get(sessionId)?.delete(onData)
      term.dispose()
    }
  }, [sessionId])
  return (
    <div
      ref={host}
      className="h-56 overflow-hidden rounded-md border bg-[#0b0b0c] p-2"
      aria-label="Setup command output"
    />
  )
}
