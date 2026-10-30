export type TerminalProfile = {
  id: string
  label: string
  command: string
  args: string[]
}

export type TerminalSessionView = {
  id: string
  // The conversation or task that owns this terminal.
  conversationId: string
  profileId: string
  title: string
  cwd: string
  status: "running" | "exited"
  exitCode?: number | null
  signal?: number | null
  // Set on a one-command session (runCommand): the command it runs. The
  // session ends when the command does.
  command?: string
}

export type TerminalDataEvent = {
  id: string
  data: string
}

export type TerminalExitEvent = {
  id: string
  exitCode: number | null
  signal: number | null
}
