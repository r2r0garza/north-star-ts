import { basename, isAbsolute, relative, resolve, sep } from "path"
import { homedir } from "os"
import { normalizeCommand } from "./normalize"
import type { ToolAction } from "./types"

export type ShellParseConfidence = "high" | "requires_approval"

export interface ShellRedirect {
  op: ">" | ">>" | "2>" | "2>>" | "<"
  target: string
}

export interface ShellCommandSegment {
  raw: string
  executable?: string
  rawArgv: string[]
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

interface ShellActionOptions extends AnalyzeOptions {
  tool?: string
  platform?: NodeJS.Platform
  runtimeProfile?: string
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
const WRAPPER_COMMANDS = new Set(["exec", "nohup", "setsid", "time", "command"])
const PACKAGE_MANAGER_COMMANDS = new Set(["npm", "pnpm", "yarn", "bun"])

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
  const substitutionAnalyses = substitutionCommands.map((sub) =>
    analyzeShellCommand(sub, platform, opts)
  )
  for (const analysis of substitutionAnalyses) {
    reasons.push(...analysis.reasons)
  }
  const substitutions = substitutionAnalyses.flatMap((analysis) => [
    ...analysis.segments,
    ...analysis.substitutions,
  ])
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
    version: 2,
    segments: allSegments.map((segment) => ({
      rawArgv: segment.rawArgv,
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

export function shellActionForCommand(
  command: string,
  opts: ShellActionOptions = {}
): ToolAction {
  const shellAnalysis = analyzeShellCommand(
    command,
    opts.platform ?? process.platform,
    {
      cwd: opts.cwd,
      workspace: opts.workspace,
    }
  )
  return {
    tool: opts.tool ?? "run_shell_tool",
    kind: "shell",
    summary: `$ ${command}`,
    identity: shellAnalysis.identity,
    detail: {
      command,
      cwd: opts.cwd,
      workspace: opts.workspace,
      shellAnalysis,
      ...(opts.runtimeProfile ? { runtimeProfile: opts.runtimeProfile } : {}),
    },
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
  const effectiveArgv = effectiveCommandArgv(argv)
  segments.push({
    raw: tokens.join(" "),
    executable: effectiveArgv[0],
    rawArgv: argv,
    argv: effectiveArgv,
    redirects,
  })
}

function extractSubstitutions(command: string, reasons: string[]): string[] {
  const out: string[] = []
  let quote: "'" | '"' | null = null
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]
    const next = command[i + 1]
    if (ch === "\\") {
      i += 1
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      if (quote === "'") continue
    } else if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === "$" && next === "(") {
      reasons.push("command substitution requires approval")
      const extracted = extractParenSubstitution(command, i + 2, reasons)
      if (extracted.body.trim()) out.push(extracted.body.trim())
      i = extracted.end
      continue
    }
    if (ch !== "`") continue
    reasons.push("backtick command substitution requires approval")
    const extracted = extractBacktickSubstitution(command, i + 1, reasons)
    if (extracted.body.trim()) out.push(extracted.body.trim())
    i = extracted.end
  }
  if (quote) reasons.push("unclosed quote requires approval")
  return out
}

function extractParenSubstitution(
  command: string,
  start: number,
  reasons: string[]
): { body: string; end: number } {
  let depth = 1
  let body = ""
  let quote: "'" | '"' | null = null
  for (let i = start; i < command.length; i += 1) {
    const ch = command[i]
    const next = command[i + 1]
    if (ch === "\\") {
      if (next) {
        body += ch + next
        i += 1
      }
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      body += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      body += ch
      continue
    }
    if (ch === "$" && next === "(") {
      depth += 1
      body += "$("
      i += 1
      continue
    }
    if (ch === ")") {
      depth -= 1
      if (depth === 0) return { body, end: i }
      body += ch
      continue
    }
    body += ch
  }
  reasons.push("unterminated command substitution requires approval")
  return { body, end: command.length - 1 }
}

function extractBacktickSubstitution(
  command: string,
  start: number,
  reasons: string[]
): { body: string; end: number } {
  let body = ""
  for (let i = start; i < command.length; i += 1) {
    const ch = command[i]
    const next = command[i + 1]
    if (ch === "\\") {
      if (next) {
        body += next
        i += 1
      }
      continue
    }
    if (ch === "`") return { body, end: i }
    body += ch
  }
  reasons.push("unterminated backtick command substitution requires approval")
  return { body, end: command.length - 1 }
}

function effectiveCommandArgv(argv: string[]): string[] {
  let index = 0
  while (index < argv.length && isAssignment(argv[index])) index += 1
  while (index < argv.length) {
    const command = basename(argv[index])
    if (command === "sudo") {
      index = skipSudo(argv, index + 1)
      continue
    }
    if (command === "env") {
      index = skipEnv(argv, index + 1)
      continue
    }
    if (WRAPPER_COMMANDS.has(command)) {
      index = skipWrapper(argv, index + 1)
      continue
    }
    break
  }
  return argv.slice(index)
}

function skipWrapper(argv: string[], index: number): number {
  while (index < argv.length && argv[index].startsWith("-")) index += 1
  while (index < argv.length && isAssignment(argv[index])) index += 1
  return index
}

function skipEnv(argv: string[], index: number): number {
  while (index < argv.length) {
    const arg = argv[index]
    if (isAssignment(arg)) {
      index += 1
      continue
    }
    if (arg === "-u" || arg === "--unset") {
      index += 2
      continue
    }
    if (arg.startsWith("-")) {
      index += 1
      continue
    }
    break
  }
  return index
}

function skipSudo(argv: string[], index: number): number {
  while (index < argv.length) {
    const arg = argv[index]
    if (isAssignment(arg)) {
      index += 1
      continue
    }
    if (arg === "--") return index + 1
    if (!arg.startsWith("-")) break
    index += sudoOptionConsumesValue(arg) ? 2 : 1
  }
  return index
}

function sudoOptionConsumesValue(arg: string): boolean {
  if (arg.includes("=")) return false
  if (["-C", "-D", "-g", "-h", "-p", "-T", "-u"].includes(arg)) return true
  return /^-[A-Za-z]*[CDghpTu][A-Za-z]*$/.test(arg) && arg.length === 2
}

function isAssignment(arg: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(arg)
}

function firstSubcommand(argv: string[]): string | null {
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--") continue
    if (arg.startsWith("-")) {
      if (optionConsumesValue(arg)) i += 1
      continue
    }
    return arg
  }
  return null
}

function optionConsumesValue(arg: string): boolean {
  return !arg.includes("=") && /^[A-Za-z0-9]$/.test(arg.slice(1))
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
  const subcommand = firstSubcommand(segment.argv)
  if (
    command === "git" &&
    subcommand &&
    GIT_NETWORK_SUBCOMMANDS.has(subcommand)
  ) {
    return `git ${subcommand}`
  }
  if (
    PACKAGE_MANAGER_COMMANDS.has(command) &&
    subcommand &&
    PACKAGE_MANAGER_NETWORK_SUBCOMMANDS.has(subcommand)
  ) {
    return `${command} ${subcommand}`
  }
  return null
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === "" || (!isParentTraversal(rel) && !isAbsolute(rel))
}

function isParentTraversal(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${sep}`)
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort()
}
