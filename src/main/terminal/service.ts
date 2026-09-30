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

  // Run one command in a PTY with the default shell, non-interactively (the
  // shell exits with the command's status), so the user watches live output
  // and can answer a prompt, and the caller learns the exit code from the
  // "exit" event (plan 106.11). The caller vets the command and directory.
  runCommand(input: {
    ownerId: string
    cwd: string
    command: string
    title: string
    env?: Record<string, string>
    cols?: number
    rows?: number
  }): TerminalSessionView {
    const cwd = input.cwd.trim()
    if (!cwd || !existsSync(cwd)) {
      throw new Error("The command's directory doesn't exist.")
    }
    const { file, args } = commandShell(input.command)
    const id = randomUUID()
    const cols = sanitizeSize(input.cols, 100)
    const rows = sanitizeSize(input.rows, 24)
    const term = pty.spawn(file, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: { ...(input.env ?? process.env), TERM: "xterm-256color" },
    })
    const view: TerminalSessionView = {
      id,
      conversationId: input.ownerId,
      profileId: "command",
      title: input.title,
      cwd,
      status: "running",
      command: input.command,
    }
    this.sessions.set(id, { view, pty: term })
    term.onData((data) => this.emit("data", { id, data }))
    term.onExit(({ exitCode, signal }) => {
      this.sessions.delete(id)
      this.emit("exit", { id, exitCode, signal: signal ?? null })
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

// The shell a one-command session runs in: /bin/sh on Unix, PowerShell on
// Windows. Not a login shell: macOS's /etc/zprofile runs path_helper, which
// moves /usr/bin back in front of the PATH the caller passed, so `python3`
// would be Apple's 3.9 in the terminal while the caller (which already put
// the user's login-shell PATH in `env`) checked Homebrew's 3.12 (plan 106.11).
// The command must run with exactly the environment it was chosen for.
function commandShell(command: string): { file: string; args: string[] } {
  if (process.platform === "win32")
    return {
      file: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-Command", command],
    }
  return { file: "/bin/sh", args: ["-c", command] }
}

function sanitizeSize(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value && value > 0
    ? Math.max(1, Math.floor(value))
    : fallback
}
