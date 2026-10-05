export type TerminalProfile = {
  id: string
  label: string
  command: string
  args: string[]
}

export type TerminalSessionView = {
  id: string
  // The owner: a conversation id, or another owner such as
  // "mission-control:<featureId>" for workspace setup runs (plan 106.11).
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
