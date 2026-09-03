import { EventEmitter } from "events"
import { randomUUID } from "crypto"
import { existsSync } from "fs"
import * as pty from "node-pty"
import { detectTerminalProfiles } from "./profiles"
import type {
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalProfile,
  TerminalSessionView,
} from "./types"

type TerminalEvents = {
  data: [TerminalDataEvent]
  exit: [TerminalExitEvent]
}

type ManagedSession = {
  view: TerminalSessionView
  pty: pty.IPty
}

export class TerminalService extends EventEmitter<TerminalEvents> {
  private readonly sessions = new Map<string, ManagedSession>()

  profiles(): TerminalProfile[] {
    return detectTerminalProfiles()
  }

  list(): TerminalSessionView[] {
    return Array.from(this.sessions.values()).map((s) => s.view)
  }

  create(input: {
    conversationId: string
    workspace: string
    profileId?: string
    cols?: number
    rows?: number
  }): TerminalSessionView {
    const cwd = input.workspace.trim()
    if (!cwd || !existsSync(cwd)) {
      throw new Error("Terminal sessions require an existing workspace.")
    }

    const profiles = this.profiles()
    const profile =
      profiles.find((p) => p.id === input.profileId) ??
      profiles[0] ??
      ({
        id: "shell",
        label: "Shell",
        command: "sh",
        args: [],
      } satisfies TerminalProfile)
    const id = randomUUID()
    const cols = sanitizeSize(input.cols, 80)
    const rows = sanitizeSize(input.rows, 24)
    const term = pty.spawn(profile.command, profile.args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: { ...process.env, TERM: "xterm-256color" },
    })
    const view: TerminalSessionView = {
      id,
      conversationId: input.conversationId,
      profileId: profile.id,
      title: profile.label,
      cwd,
      status: "running",
    }
    this.sessions.set(id, { view, pty: term })

    term.onData((data) => this.emit("data", { id, data }))
    term.onExit(({ exitCode, signal }) => {
      const normalizedSignal = signal ?? null
      const session = this.sessions.get(id)
      if (session) {
        this.sessions.delete(id)
      }
      this.emit("exit", { id, exitCode, signal: normalizedSignal })
    })

    return view
  }

  adoptConversation(
    fromConversationId: string,
    toConversationId: string
  ): void {
    const from = fromConversationId.trim()
    const to = toConversationId.trim()
    if (!from || !to || from === to) return
    for (const session of this.sessions.values()) {
      if (session.view.conversationId === from) {
        session.view = { ...session.view, conversationId: to }
      }
    }
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.sessions
      .get(id)
      ?.pty.resize(sanitizeSize(cols, 80), sanitizeSize(rows, 24))
  }

  kill(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.pty.kill()
    this.sessions.delete(id)
  }

  dispose(): void {
    for (const id of Array.from(this.sessions.keys())) this.kill(id)
    this.removeAllListeners()
  }
}

function sanitizeSize(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value && value > 0
    ? Math.max(1, Math.floor(value))
    : fallback
}
