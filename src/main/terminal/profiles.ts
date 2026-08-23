import { existsSync } from "fs"
import { delimiter, join } from "path"
import type { TerminalProfile } from "./types"

function isExecutableOnPath(command: string): boolean {
  if (command.includes("/") || command.includes("\\"))
    return existsSync(command)
  const paths = (process.env.PATH ?? "").split(delimiter).filter(Boolean)
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""]
  return paths.some((dir) =>
    extensions.some((ext) => existsSync(join(dir, `${command}${ext}`)))
  )
}

function uniqueProfiles(profiles: TerminalProfile[]): TerminalProfile[] {
  const seen = new Set<string>()
  return profiles.filter((p) => {
    if (seen.has(p.id)) return false
    seen.add(p.id)
    return true
  })
}

export function detectTerminalProfiles(): TerminalProfile[] {
  if (process.platform === "win32") return detectWindowsProfiles()
  return detectUnixProfiles()
}

function detectUnixProfiles(): TerminalProfile[] {
  const shell = process.env.SHELL
  const profiles: TerminalProfile[] = []
  if (shell && existsSync(shell)) {
    const name = shell.split("/").pop() || "Shell"
    profiles.push({
      id: "default",
      label: `Default shell (${name})`,
      command: shell,
      args: ["-l"],
    })
  }
  for (const command of ["zsh", "bash", "fish"]) {
    if (!isExecutableOnPath(command)) continue
    profiles.push({
      id: command,
      label: command === "zsh" ? "Zsh" : command === "bash" ? "Bash" : "Fish",
      command,
      args: command === "fish" ? [] : ["-l"],
    })
  }
  return uniqueProfiles(
    profiles.length
      ? profiles
      : [{ id: "sh", label: "Shell", command: "sh", args: [] }]
  )
}

function detectWindowsProfiles(): TerminalProfile[] {
  const profiles: TerminalProfile[] = [
    {
      id: "powershell",
      label: "PowerShell",
      command: "powershell.exe",
      args: ["-NoLogo"],
    },
    {
      id: "cmd",
      label: "Command Prompt",
      command: "cmd.exe",
      args: [],
    },
  ]
  if (isExecutableOnPath("pwsh")) {
    profiles.splice(1, 0, {
      id: "pwsh",
      label: "PowerShell 7",
      command: "pwsh.exe",
      args: ["-NoLogo"],
    })
  }

  const gitBash =
    [
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    ].find((path) => existsSync(path)) ??
    (isExecutableOnPath("bash") ? "bash.exe" : null)
  if (gitBash) {
    profiles.push({
      id: "git-bash",
      label: "Git Bash",
      command: gitBash,
      args: ["--login", "-i"],
    })
  }
  return uniqueProfiles(profiles)
}
