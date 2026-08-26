import type {
  ExecResult,
  SearchCase,
  SearchCount,
  SearchMatch,
  SearchMode,
  SearchOptions,
  SearchResult,
} from "./types"

export class SearchExecutionError extends Error {
  constructor(
    readonly code: "search_unavailable" | "search_failed" | "aborted",
    message: string
  ) {
    super(message)
    this.name = "SearchExecutionError"
  }
}

export class SearchPatternError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SearchPatternError"
  }
}

export function isSearchExecutionError(
  err: unknown
): err is SearchExecutionError {
  return err instanceof SearchExecutionError
}

export function isSearchPatternError(err: unknown): err is SearchPatternError {
  return err instanceof SearchPatternError
}

interface RgText {
  text: string
}

interface RgEvent {
  type: string
  data?: {
    path?: RgText
    lines?: RgText
    line_number?: number
    submatches?: Array<{ start: number; end: number; match?: RgText }>
  }
}

export function buildRipgrepArgs(opts: SearchOptions): string[] {
  const args = [
    "--json",
    "--color",
    "never",
    "--max-filesize",
    String(opts.maxFileBytes),
  ]

  if (opts.mode === "fixed") args.push("--fixed-strings")
  if (opts.case === "smart") args.push("--smart-case")
  else if (opts.case === "insensitive") args.push("--ignore-case")
  else args.push("--case-sensitive")

  if (opts.includeHidden) args.push("--hidden")
  if (!opts.respectIgnore) args.push("--no-ignore")

  for (const glob of expandRipgrepGlobs(opts.globs)) {
    args.push("--glob", glob)
  }

  if (opts.beforeContext > 0)
    args.push("--before-context", String(opts.beforeContext))
  if (opts.afterContext > 0)
    args.push("--after-context", String(opts.afterContext))

  args.push("--", opts.query, opts.root)
  return args
}

function expandRipgrepGlobs(globs: string[]): string[] {
  const expanded: string[] = []
  for (const glob of globs) {
    expanded.push(glob)
    if (glob.startsWith("!**/")) {
      expanded.push(`!${glob.slice(4)}`)
    }
  }
  return expanded
}

export function parseRipgrepJson(
  stdout: Buffer,
  opts: SearchOptions
): SearchResult {
  const matches: SearchMatch[] = []
  const files: string[] = []
  const fileSet = new Set<string>()
  const counts = new Map<string, number>()
  let totalMatches = 0
  let capped = false

  const addFile = (path: string) => {
    if (fileSet.has(path)) return
    if (opts.result === "files" && files.length >= opts.maxResults) {
      capped = true
      return
    }
    fileSet.add(path)
    files.push(path)
  }

  for (const line of stdout.toString("utf8").split("\n")) {
    if (!line.trim()) continue
    let event: RgEvent
    try {
      event = JSON.parse(line) as RgEvent
    } catch {
      continue
    }

    if (event.type !== "match" && event.type !== "context") continue
    const path = event.data?.path?.text
    const text = event.data?.lines?.text
    const lineNumber = event.data?.line_number
    if (!path || typeof text !== "string" || typeof lineNumber !== "number") {
      continue
    }

    if (event.type === "match") {
      const submatches = event.data?.submatches ?? []
      const increment = submatches.length > 0 ? submatches.length : 1
      totalMatches += increment
      counts.set(path, (counts.get(path) ?? 0) + increment)
      addFile(path)
    }

    if (opts.result !== "content") continue
    if (matches.length >= opts.maxResults) {
      capped = true
      continue
    }

    const first = event.data?.submatches?.[0]
    matches.push({
      path,
      line: lineNumber,
      column: first ? first.start + 1 : undefined,
      text: trimLineEnding(text),
      kind: event.type === "context" ? "context" : "match",
    })
  }

  const countRows: SearchCount[] = []
  for (const [path, matchCount] of counts.entries()) {
    if (countRows.length >= opts.maxResults) {
      capped = true
      break
    }
    countRows.push({ path, matches: matchCount })
  }

  return {
    engine: "rg",
    result: opts.result,
    matches,
    files,
    counts: countRows,
    totalMatches,
    capped,
  }
}

export function throwForRipgrepExecutionFailure(
  res: ExecResult,
  fallbackMessage = "ripgrep failed"
): void {
  const stderr = res.stderr?.toString("utf8").trim()
  const message = stderr || res.stdout.toString("utf8").trim()
  if (res.aborted) {
    throw new SearchExecutionError("aborted", "The search was cancelled.")
  }
  if (res.timedOut) {
    throw new SearchExecutionError("search_failed", "ripgrep search timed out")
  }
  if (res.exitCode === null) {
    const detail = res.spawnError || message
    throw new SearchExecutionError(
      "search_unavailable",
      detail ? `ripgrep could not start: ${detail}` : "ripgrep could not start"
    )
  }
  if (res.signal) {
    throw new SearchExecutionError(
      "search_failed",
      `ripgrep terminated by signal ${res.signal}`
    )
  }
  if (res.exitCode > 1) {
    if (isRipgrepRegexParseError(message)) {
      throw new SearchPatternError(message)
    }
    throw new SearchExecutionError("search_failed", message || fallbackMessage)
  }
}

export function legacyGlobToRipgrepGlob(glob: string): string {
  if (!glob) return glob
  if (
    glob.includes("*") ||
    glob.includes("?") ||
    glob.includes("[") ||
    glob.startsWith("!")
  ) {
    return glob
  }
  return `*${glob}*`
}

function trimLineEnding(text: string): string {
  return text.replace(/\r?\n$/, "")
}

function isRipgrepRegexParseError(message: string): boolean {
  return /\brg: regex parse error:/i.test(message)
}
