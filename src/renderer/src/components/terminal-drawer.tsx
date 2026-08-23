import * as React from "react"
import { FitAddon } from "@xterm/addon-fit"
import { Terminal as XtermTerminal } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"
import { ChevronDown, Plus, Terminal, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import type { TerminalProfile, TerminalSessionView } from "@/types"

const TERMINAL_KEYBOARD_SHORTCUT = "j"
const NEW_TERMINAL_KEYBOARD_SHORTCUT = "t"
const DEFAULT_HEIGHT = 320

export function TerminalToggle({
  open,
  onToggle,
  reserveWindowControls = false,
}: {
  open: boolean
  onToggle: () => void
  reserveWindowControls?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={open ? "Hide terminal" : "Show terminal"}
      title={open ? "Hide terminal" : "Show terminal"}
      className={cn(
        "absolute top-2.5 z-30 flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors [-webkit-app-region:no-drag] hover:bg-muted hover:text-foreground",
        reserveWindowControls ? "right-[19.25rem]" : "right-[11.5rem]"
      )}
    >
      <Terminal className="size-4.5" />
    </button>
  )
}

export function useTerminalShortcut(enabled: boolean, onToggle: () => void) {
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() === TERMINAL_KEYBOARD_SHORTCUT &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault()
        if (!enabled) return
        onToggle()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [enabled, onToggle])
}

export function TerminalDrawer({
  open,
  conversationId,
  workspace,
  onOpenChange,
}: {
  open: boolean
  conversationId: string | null
  workspace: string
  onOpenChange: (open: boolean) => void
}) {
  const [profiles, setProfiles] = React.useState<TerminalProfile[]>([])
  const [sessions, setSessions] = React.useState<TerminalSessionView[]>([])
  const [activeIdByConversation, setActiveIdByConversation] = React.useState<
    Record<string, string | null>
  >({})
  const [titlesBySession, setTitlesBySession] = React.useState<
    Record<string, string>
  >({})
  const [renamingId, setRenamingId] = React.useState<string | null>(null)
  const [renameDraft, setRenameDraft] = React.useState("")
  const [height, setHeight] = React.useState(DEFAULT_HEIGHT)
  const outputBuffers = React.useRef(new Map<string, string[]>())
  const writers = React.useRef(new Map<string, (data: string) => void>())
  const skipRenameBlur = React.useRef(false)
  const renameInputRef = React.useRef<HTMLInputElement | null>(null)
  const wasOpen = React.useRef(open)
  const conversationSessions = React.useMemo(
    () =>
      sessions.filter(
        (session) =>
          session.conversationId === conversationId && session.cwd === workspace
      ),
    [conversationId, sessions, workspace]
  )
  const activeId = conversationId
    ? (activeIdByConversation[conversationId] ?? null)
    : null
  const setActiveIdForConversation = React.useCallback(
    (id: string | null) => {
      if (!conversationId) return
      setActiveIdByConversation((state) => ({
        ...state,
        [conversationId]: id,
      }))
    },
    [conversationId]
  )

  const forgetSessionUi = React.useCallback((id: string) => {
    writers.current.delete(id)
    outputBuffers.current.delete(id)
    setTitlesBySession((state) => {
      const next = { ...state }
      delete next[id]
      return next
    })
  }, [])

  React.useEffect(() => {
    void window.cowork.terminal.profiles().then(setProfiles)
    void window.cowork.terminal.list().then((rows) => {
      setSessions(rows)
    })
  }, [])

  React.useEffect(() => {
    const offData = window.cowork.terminal.onData(({ id, data }) => {
      const write = writers.current.get(id)
      if (write) {
        write(data)
        return
      }
      const pending = outputBuffers.current.get(id) ?? []
      pending.push(data)
      outputBuffers.current.set(id, pending)
    })
    const offExit = window.cowork.terminal.onExit(({ id }) => {
      forgetSessionUi(id)
      setSessions((rows) => {
        const exited = rows.find((row) => row.id === id)
        const next = rows.filter((row) => row.id !== id)
        if (exited) {
          const remainingInConversation = next.filter(
            (row) =>
              row.conversationId === exited.conversationId &&
              row.cwd === exited.cwd
          )
          setActiveIdByConversation((state) => ({
            ...state,
            [exited.conversationId]:
              state[exited.conversationId] === id
                ? (remainingInConversation[remainingInConversation.length - 1]
                    ?.id ?? null)
                : (state[exited.conversationId] ?? null),
          }))
          if (
            exited.conversationId === conversationId &&
            exited.cwd === workspace &&
            remainingInConversation.length === 0
          ) {
            onOpenChange(false)
          }
        }
        return next
      })
    })
    return () => {
      offData()
      offExit()
    }
  }, [conversationId, forgetSessionUi, onOpenChange, workspace])

  const createSession = React.useCallback(
    async (profileId?: string) => {
      if (!conversationId || !workspace) return
      try {
        const session = await window.cowork.terminal.create({
          conversationId,
          workspace,
          profileId,
          cols: 100,
          rows: 24,
        })
        setSessions((rows) => [...rows, session])
        setActiveIdForConversation(session.id)
        onOpenChange(true)
      } catch (err) {
        toast.error("Could not open terminal", {
          description: err instanceof Error ? err.message : String(err),
        })
      }
    },
    [conversationId, onOpenChange, setActiveIdForConversation, workspace]
  )

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== NEW_TERMINAL_KEYBOARD_SHORTCUT ||
        !(event.metaKey || event.ctrlKey)
      ) {
        return
      }
      event.preventDefault()
      if (!conversationId || !workspace) return
      void createSession()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [conversationId, createSession, workspace])

  async function closeSession(id: string) {
    await window.cowork.terminal.kill(id)
    forgetSessionUi(id)
    setSessions((rows) => {
      const next = rows.filter((row) => row.id !== id)
      const remainingInConversation = next.filter(
        (row) => row.conversationId === conversationId && row.cwd === workspace
      )
      if (remainingInConversation.length === 0) onOpenChange(false)
      if (activeId === id) {
        setActiveIdForConversation(
          remainingInConversation[remainingInConversation.length - 1]?.id ??
            null
        )
      }
      return next
    })
  }

  const registerWriter = React.useCallback(
    (id: string, write: (data: string) => void) => {
      writers.current.set(id, write)
      const pending = outputBuffers.current.get(id)
      if (pending?.length) {
        pending.forEach(write)
        outputBuffers.current.delete(id)
      }
      return () => {
        writers.current.delete(id)
      }
    },
    []
  )

  React.useEffect(() => {
    const opened = open && !wasOpen.current
    wasOpen.current = open
    if (
      !opened ||
      conversationSessions.length > 0 ||
      !conversationId ||
      !workspace
    )
      return
    void createSession()
  }, [
    conversationId,
    conversationSessions.length,
    createSession,
    open,
    workspace,
  ])

  React.useEffect(() => {
    if (!conversationId) return
    if (
      activeId &&
      conversationSessions.some((session) => session.id === activeId)
    )
      return
    setActiveIdForConversation(conversationSessions[0]?.id ?? null)
  }, [
    activeId,
    conversationId,
    conversationSessions,
    setActiveIdForConversation,
  ])

  const activeSession =
    conversationSessions.find((session) => session.id === activeId) ?? null

  React.useLayoutEffect(() => {
    if (!renamingId) return
    const frame = requestAnimationFrame(() => {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [renamingId])

  const startResize = (event: React.MouseEvent) => {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = height
    const onMove = (ev: MouseEvent) => {
      const max = Math.max(220, window.innerHeight - 120)
      setHeight(Math.min(max, Math.max(180, startHeight + startY - ev.clientY)))
    }
    const onUp = () => {
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
      document.body.style.userSelect = ""
    }
    document.body.style.userSelect = "none"
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
  }

  function startRename(session: TerminalSessionView) {
    setRenamingId(session.id)
    setRenameDraft(titlesBySession[session.id] ?? session.title)
  }

  function commitRename(id: string) {
    if (skipRenameBlur.current) {
      skipRenameBlur.current = false
      return
    }
    const next = renameDraft.trim()
    setTitlesBySession((state) => {
      if (!next) {
        const cleared = { ...state }
        delete cleared[id]
        return cleared
      }
      return { ...state, [id]: next }
    })
    setRenamingId(null)
    setRenameDraft("")
  }

  function cancelRename() {
    skipRenameBlur.current = true
    setRenamingId(null)
    setRenameDraft("")
  }

  return (
    <div
      className={cn(
        "relative z-10 flex shrink-0 flex-col overflow-hidden border-t bg-background shadow-[0_-8px_32px_rgb(0_0_0/0.08)] transition-[height] duration-200",
        open ? "border-border" : "border-transparent"
      )}
      style={{ height: open ? height : 0 }}
      aria-hidden={!open}
    >
      <div
        onMouseDown={startResize}
        className="h-1 shrink-0 cursor-row-resize bg-border/70 transition-colors hover:bg-primary/50"
      />
      <div className="flex h-10 shrink-0 items-center gap-1 border-b bg-muted/40 px-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {conversationSessions.map((session) => {
            const title = titlesBySession[session.id] ?? session.title
            return (
              <ContextMenu key={session.id}>
                <ContextMenuTrigger asChild>
                  <div
                    className={cn(
                      "flex h-7 max-w-56 min-w-24 items-center rounded-md text-xs transition-colors",
                      session.id === activeId
                        ? "bg-background text-foreground shadow-xs"
                        : "text-muted-foreground hover:bg-background/60 hover:text-foreground"
                    )}
                  >
                    {renamingId === session.id ? (
                      <form
                        className="flex h-full min-w-0 flex-1 items-center px-1.5"
                        onSubmit={(event) => {
                          event.preventDefault()
                          commitRename(session.id)
                        }}
                      >
                        <input
                          ref={renameInputRef}
                          value={renameDraft}
                          onChange={(event) =>
                            setRenameDraft(event.target.value)
                          }
                          onBlur={() => commitRename(session.id)}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              event.preventDefault()
                              cancelRename()
                            }
                          }}
                          className="h-5 min-w-0 flex-1 rounded-sm border border-border bg-background px-1 text-xs text-foreground outline-none focus:border-ring"
                        />
                      </form>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setActiveIdForConversation(session.id)}
                        onDoubleClick={() => startRename(session)}
                        className="flex h-full min-w-0 flex-1 items-center gap-2 px-2 text-left"
                      >
                        <Terminal className="size-3.5 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">
                          {title}
                          {session.status === "exited" ? " (exited)" : ""}
                        </span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        void closeSession(session.id)
                      }}
                      className="mr-1 flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-muted"
                      aria-label={`Close ${title}`}
                      title={`Close ${title}`}
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onSelect={() => startRename(session)}>
                    Rename
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            )
          })}
          {conversationSessions.length === 0 && (
            <span className="px-2 text-xs text-muted-foreground">
              {workspace
                ? "No terminals open"
                : "Open a workspace to use Terminal"}
            </span>
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              disabled={!workspace || profiles.length === 0}
            >
              <Plus className="size-3.5" />
              New
              <ChevronDown className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            {profiles.map((profile) => (
              <DropdownMenuItem
                key={profile.id}
                onSelect={() => void createSession(profile.id)}
              >
                {profile.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => onOpenChange(false)}
          aria-label="Hide terminal"
          title="Hide terminal"
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1 bg-[#0c0d0e]">
        {sessions.map((session) => (
          <TerminalPane
            key={session.id}
            session={session}
            active={session.id === activeSession?.id && open}
            registerWriter={registerWriter}
          />
        ))}
        {!activeSession && (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            {workspace
              ? "Create a terminal to start a shell in this workspace."
              : "Terminal requires a workspace-backed conversation."}
          </div>
        )}
      </div>
    </div>
  )
}

function TerminalPane({
  session,
  active,
  registerWriter,
}: {
  session: TerminalSessionView
  active: boolean
  registerWriter: (id: string, write: (data: string) => void) => () => void
}) {
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const termRef = React.useRef<XtermTerminal | null>(null)
  const fitRef = React.useRef<FitAddon | null>(null)

  React.useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new XtermTerminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 5000,
      theme: {
        background: "#0c0d0e",
        foreground: "#d7d7d7",
        cursor: "#f6f6f6",
        selectionBackground: "#3b82f680",
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    term.onData((data) => {
      void window.cowork.terminal.write(session.id, data)
    })

    termRef.current = term
    fitRef.current = fit
    const unregister = registerWriter(session.id, (data) => term.write(data))
    const resize = () => {
      if (host.clientWidth === 0 || host.clientHeight === 0) return
      try {
        fit.fit()
        window.cowork.terminal.resize(session.id, term.cols, term.rows)
      } catch {
        // xterm can briefly report zero dimensions while the drawer animates.
      }
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    requestAnimationFrame(resize)

    return () => {
      observer.disconnect()
      unregister()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [registerWriter, session.id])

  React.useEffect(() => {
    if (!active) return
    const term = termRef.current
    const fit = fitRef.current
    requestAnimationFrame(() => {
      try {
        fit?.fit()
        if (term) {
          window.cowork.terminal.resize(session.id, term.cols, term.rows)
          term.focus()
        }
      } catch {
        // Ignore transient zero-size fits while opening.
      }
    })
  }, [active, session.id])

  return (
    <div
      ref={hostRef}
      className={cn(
        "absolute inset-0 size-full p-2",
        active ? "block" : "hidden"
      )}
    />
  )
}
