import { basename, isAbsolute, relative, resolve } from "path"
import { homedir } from "os"
import { normalizeCommand } from "./normalize"

export type ShellParseConfidence = "high" | "requires_approval"

export interface ShellRedirect {
  op: ">" | ">>" | "2>" | "2>>" | "<"
  target: string
}

export interface ShellCommandSegment {
  raw: string
  executable?: string
  argv: string[]
  redirects: ShellRedirect[]
}

export interface ShellCommandAnalysis {
  platform: NodeJS.Platform
  confidence: ShellParseConfidence
  reasons: string[]
  segments: ShellCommandSegment[]
  substitutions: ShellCommandSegment[]
  redirects: ShellRedirect[]
  candidateReadPaths: string[]
  candidateWritePaths: string[]
  outsideWorkspacePaths: string[]
  networkOperations: string[]
  identity: string
}

interface AnalyzeOptions {
  cwd?: string
  workspace?: string
}

const COMMAND_SEPARATORS = new Set([";", "&&", "||", "|", "\n"])
const OUTPUT_REDIRECTS = new Set([">", ">>", "2>", "2>>"])
const INPUT_REDIRECTS = new Set(["<"])
const NETWORK_COMMANDS = new Set([
  "curl",
  "wget",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "telnet",
  "nc",
  "netcat",
])
const PACKAGE_MANAGER_NETWORK_SUBCOMMANDS = new Set([
  "add",
  "install",
  "i",
  "update",
  "upgrade",
])
const GIT_NETWORK_SUBCOMMANDS = new Set([
  "clone",
  "fetch",
  "pull",
  "push",
  "ls-remote",
  "submodule",
])

export function analyzeShellCommand(
  command: string,
  platform: NodeJS.Platform,
  opts: AnalyzeOptions = {}
): ShellCommandAnalysis {
  const normalized = normalizeCommand(command)
  const reasons: string[] = []
  const tokens = tokenize(normalized, reasons)
  const substitutionCommands = extractSubstitutions(normalized, reasons)
  const segments = parseSegments(tokens)
  const substitutions = substitutionCommands.flatMap(
    (sub) => analyzeShellCommand(sub, platform, opts).segments
  )
  const allSegments = [...segments, ...substitutions]
  const redirects = allSegments.flatMap((segment) => segment.redirects)
  const candidateReadPaths = unique(
    allSegments.flatMap((segment) => candidatePaths(segment.argv, opts.cwd))
  )
  const candidateWritePaths = unique(
    redirects
      .filter((redirect) => OUTPUT_REDIRECTS.has(redirect.op))
      .map((redirect) =>
        normalizePathCandidate(redirect.target, opts.cwd, true)
      )
      .filter((path): path is string => !!path)
  )
  for (const redirect of redirects) {
    if (INPUT_REDIRECTS.has(redirect.op)) {
      const path = normalizePathCandidate(redirect.target, opts.cwd, true)
      if (path) candidateReadPaths.push(path)
    }
  }
  const outsideWorkspacePaths = opts.workspace
    ? unique(
        [...candidateReadPaths, ...candidateWritePaths].filter(
          (path) => !isInside(opts.workspace!, path)
        )
      )
    : []
  const networkOperations = unique(
    allSegments
      .map((segment) => detectNetworkOperation(segment))
      .filter((op): op is string => !!op)
  )
  if (platform === "win32") {
    reasons.push("Windows shell syntax is not parsed by the POSIX analyzer")
  }

  const identityParts = {
    segments: allSegments.map((segment) => ({
      executable: segment.executable ?? "",
      argv: segment.argv,
      redirects: segment.redirects,
    })),
    read: candidateReadPaths,
    write: candidateWritePaths,
    network: networkOperations,
  }

  return {
    platform,
    confidence: reasons.length > 0 ? "requires_approval" : "high",
    reasons: unique(reasons),
    segments,
    substitutions,
    redirects,
    candidateReadPaths: unique(candidateReadPaths),
    candidateWritePaths,
    outsideWorkspacePaths,
    networkOperations,
    identity: `shell:${JSON.stringify(identityParts)}`,
  }
}

function tokenize(command: string, reasons: string[]): string[] {
  const tokens: string[] = []
  let token = ""
  let quote: "'" | '"' | null = null
  const pushToken = () => {
    if (token) tokens.push(token)
  }
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]
    const next = command[i + 1]
    const two = ch + next
    if (quote) {
      if (ch === quote) quote = null
      else token += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === "\\") {
      if (next) {
        token += next
        i += 1
      }
      continue
    }
    if (ch === "$" && next === "(") {
      reasons.push("command substitution requires approval")
      token += "$("
      i += 1
      continue
    }
    if (ch === "<" && next === "<") {
      reasons.push("heredoc syntax requires approval")
      pushToken()
      token = ""
      tokens.push("<<")
      i += 1
      continue
    }
    if ((ch === "<" || ch === ">") && next === "(") {
      reasons.push("process substitution requires approval")
    }
    if (ch === "2" && next === ">" && command[i + 2] === ">") {
      pushToken()
      token = ""
      tokens.push("2>>")
      i += 2
      continue
    }
    if (two === "&&" || two === "||" || two === ">>" || two === "2>") {
      pushToken()
      token = ""
      tokens.push(two)
      i += 1
      continue
    }
    if (ch === ";" || ch === "|" || ch === "<" || ch === ">" || ch === "\n") {
      pushToken()
      token = ""
      tokens.push(ch)
      continue
    }
    if (/\s/.test(ch)) {
      pushToken()
      token = ""
      continue
    }
    token += ch
  }
  if (quote) reasons.push("unclosed quote requires approval")
  pushToken()
  return tokens.filter(Boolean)
}

function parseSegments(tokens: string[]): ShellCommandSegment[] {
  const segments: ShellCommandSegment[] = []
  let current: string[] = []
  for (const token of tokens) {
    if (COMMAND_SEPARATORS.has(token)) {
      pushSegment(segments, current)
      current = []
    } else {
      current.push(token)
    }
  }
  pushSegment(segments, current)
  return segments
}

function pushSegment(segments: ShellCommandSegment[], tokens: string[]): void {
  const argv: string[] = []
  const redirects: ShellRedirect[] = []
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (OUTPUT_REDIRECTS.has(token) || INPUT_REDIRECTS.has(token)) {
      const target = tokens[i + 1] ?? ""
      if (target) {
        redirects.push({ op: token as ShellRedirect["op"], target })
        i += 1
      }
      continue
    }
    argv.push(token)
  }
  if (argv.length === 0 && redirects.length === 0) return
  segments.push({
    raw: tokens.join(" "),
    executable: argv[0],
    argv,
    redirects,
  })
}

function extractSubstitutions(command: string, reasons: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < command.length; i += 1) {
    if (command[i] !== "$" || command[i + 1] !== "(") continue
    let depth = 1
    let body = ""
    i += 2
    for (; i < command.length; i += 1) {
      const ch = command[i]
      if (ch === "(") depth += 1
      if (ch === ")") depth -= 1
      if (depth === 0) break
      body += ch
    }
    if (depth === 0 && body.trim()) out.push(body.trim())
    else reasons.push("unterminated command substitution requires approval")
  }
  return out
}

function candidatePaths(argv: string[], cwd?: string): string[] {
  return unique(
    argv
      .slice(1)
      .map((arg) => normalizePathCandidate(arg, cwd))
      .filter((path): path is string => !!path)
  )
}

function normalizePathCandidate(
  arg: string,
  cwd = process.cwd(),
  bareIsPath = false
): string | null {
  if (!arg || arg.startsWith("-")) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) return null
  if (arg.includes("*") || arg.includes("?") || arg.includes("[")) return null
  if (arg.startsWith("~")) {
    return resolve(homedir(), arg.slice(2))
  }
  if (isAbsolute(arg)) return resolve(arg)
  if (arg.startsWith("./") || arg.startsWith("../") || arg.includes("/")) {
    return resolve(cwd, arg)
  }
  if (bareIsPath) return resolve(cwd, arg)
  return null
}

function detectNetworkOperation(segment: ShellCommandSegment): string | null {
  const command = segment.executable ? basename(segment.executable) : ""
  if (!command) return null
  if (NETWORK_COMMANDS.has(command)) return command
  const subcommand = segment.argv.find(
    (arg, index) => index > 0 && !arg.startsWith("-")
  )
  if (
    command === "git" &&
    subcommand &&
    GIT_NETWORK_SUBCOMMANDS.has(subcommand)
  ) {
    return `git ${subcommand}`
  }
  if (
    ["npm", "pnpm", "yarn", "bun"].includes(command) &&
    subcommand &&
    PACKAGE_MANAGER_NETWORK_SUBCOMMANDS.has(subcommand)
  ) {
    return `${command} ${subcommand}`
  }
  return null
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort()
}
