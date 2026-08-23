export type TerminalProfile = {
  id: string
  label: string
  command: string
  args: string[]
}

export type TerminalSessionView = {
  id: string
  conversationId: string
  profileId: string
  title: string
  cwd: string
  status: "running" | "exited"
  exitCode?: number | null
  signal?: number | null
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
