// The execution + filesystem backend a turn's tools run against. Every fs/spawn
// operation a workspace tool performs goes through an Environment, so the same
// tool code runs against the host (LocalEnvironment) or inside a container
// (ContainerEnvironment). Tools keep all their high-level logic — paging, binary
// detection, occurrence counting, atomic-write orchestration, the search walk —
// and the Environment is a thin "where do bytes/processes live" seam exposing
// just the primitives those tools need.
//
// Paths passed to file ops are absolute paths in THIS environment's filesystem
// view: host paths for Local, in-container paths (under the bind-mount) for
// Container. Tools obtain them via `resolve`/`resolveLexical`, which the env
// binds to its workspace, so a tool never constructs an env-specific path itself.

// Result of running a command. Mirrors run_shell_tool's original RunResult so the
// tool's status-string logic is unchanged. `stdout` is the raw combined
// stdout+stderr as a Buffer — the caller decodes utf8 ONCE, because decoding
// per-chunk would corrupt a multibyte character straddling a chunk boundary.
export interface ExecResult {
  stdout: Buffer
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
}

export interface ExecOptions {
  // Absolute working directory within this environment's filesystem view.
  cwd: string
  timeoutMs: number
  // Hard cap on captured output bytes, so a runaway command can't exhaust memory.
  maxOutputBytes: number
  // Abort seam (see .plan/005): when it fires, the running process is killed.
  // Nothing fires it yet, so with no signal the behavior is identical to before.
  signal?: AbortSignal
}

export type CommandStream = "stdout" | "stderr" | "pty"

export interface CommandChunk {
  stream: CommandStream
  data: Buffer
}

export interface CommandExit {
  exitCode: number | null
  signal: NodeJS.Signals | null
}

export interface CommandSessionHandle {
  onData(cb: (chunk: CommandChunk) => void): void
  onExit(cb: (exit: CommandExit) => void): void
  write(data: string): void
  closeStdin(): void
  interrupt(): void
  kill(): void
}

export interface SpawnCommandOptions {
  // Absolute working directory within this environment's filesystem view.
  cwd: string
  // Use a PTY when the backend supports it. PTY output is one stream.
  tty: boolean
  // Abort seam: Stop/app cleanup terminates the command session.
  signal?: AbortSignal
}

export type LocalRuntimeProfile =
  | "host-access"
  | "workspace-write"
  | "read-only"

export interface LocalProfileCapabilities {
  supported: boolean
  reason?: string
}

// The subset of fs.Dirent the tools consume. Real fs.Dirent satisfies this, so
// LocalEnvironment returns Dirents directly; ContainerEnvironment synthesizes
// objects of this shape from `ls` output.
export interface DirEntry {
  name: string
  isDirectory(): boolean
  isFile(): boolean
}

// The subset of fs.Stats the tools consume. Real fs.Stats satisfies this.
export interface StatInfo {
  size: number
  // Permission bits only; callers must not infer ownership, ACLs, or platform
  // flags from this value.
  mode?: number
  isFile(): boolean
  isDirectory(): boolean
}

export interface ReadTextLinesOptions {
  // 1-based line number to start at.
  offset: number
  // Maximum complete lines to return.
  limit: number
  // Maximum UTF-8 bytes of file content to return.
  maxBytes: number
}

export interface ReadTextLinesResult {
  text: string
  startLine: number
  endLine: number
  hasMore: boolean
  nextOffset?: number
  fileBytes: number
  truncated: boolean
  revision?: string
  lineTooLong?: boolean
}

export type SearchMode = "regex" | "fixed"
export type SearchCase = "smart" | "sensitive" | "insensitive"
export type SearchResultMode = "content" | "files" | "count"

// Inputs for a content search. Backend-agnostic: the tool resolves `root` in the
// env's filesystem view and passes concrete search policy, so both backends honor
// the same mode, glob, ignore, hidden-file, context, and cap contract.
export interface SearchOptions {
  // Absolute path (in this env's view) to search under.
  root: string
  // The pattern/query, passed to ripgrep as argv data.
  query: string
  mode: SearchMode
  case: SearchCase
  // Real ripgrep include/exclude globs. Legacy `glob` is normalized by the tool.
  globs: string[]
  result: SearchResultMode
  beforeContext: number
  afterContext: number
  includeHidden: boolean
  respectIgnore: boolean
  // Stop after this many result items (content lines, files, or count rows).
  maxResults: number
  // Skip files larger than this many bytes where the engine supports it.
  maxFileBytes: number
  signal?: AbortSignal
}

// One matching or context line. `path` is absolute in the env's filesystem view;
// the tool renders it relative to the workspace root for display.
export interface SearchMatch {
  path: string
  line: number
  column?: number
  text: string
  kind?: "match" | "context"
}

export interface SearchCount {
  path: string
  matches: number
}

export interface SearchResult {
  engine: "rg" | "grep"
  result: SearchResultMode
  matches: SearchMatch[]
  files: string[]
  counts: SearchCount[]
  totalMatches?: number
  // True when the search stopped at maxResults (more results may exist).
  capped: boolean
  reducedFeatures?: string[]
}

export interface Environment {
  // Resolve a model-supplied, workspace-relative path to a safe absolute path in
  // this environment's filesystem view. Symlink-safe (realpath-based) variant.
  resolve(path: string): Promise<string>
  // Lexical-only resolve (no realpath) — used by list_files, as today.
  resolveLexical(path: string): string

  readFile(path: string): Promise<Buffer>
  readTextLines(
    path: string,
    opts: ReadTextLinesOptions
  ): Promise<ReadTextLinesResult>
  // Write utf8 text. Combined with `rename` this lets tools keep their atomic-
  // write orchestration (write temp sibling, then rename over the target).
  // Newly-created files use the backend's normal file-create mode (local and
  // container backends create as 0o666 filtered by the active process umask).
  writeFile(path: string, data: string): Promise<void>
  chmod(path: string, mode: number): Promise<void>
  rename(from: string, to: string): Promise<void>
  // Atomically install an already-written file at `to`, failing if `to` exists.
  // The source file remains for caller-owned cleanup.
  installFileNoReplace?(from: string, to: string): Promise<void>
  removeFile(path: string): Promise<void>
  mkdirp(path: string): Promise<void>
  stat(path: string): Promise<StatInfo>
  readdir(path: string): Promise<DirEntry[]>

  exec(command: string, opts: ExecOptions): Promise<ExecResult>

  // Spawn a command session that can be polled and written to. Implementations
  // return immediately with a live handle; the agent session manager owns output
  // buffering, timeouts, and lifecycle cleanup.
  spawnCommand(
    command: string,
    opts: SpawnCommandOptions
  ): Promise<CommandSessionHandle>

  // Bulk content search under `opts.root`. This is a first-class env operation
  // (not a tool-side walk over readdir/stat/readFile) because search fans out
  // over the whole tree: on a container, a per-file walk is hundreds of slow
  // `exec` round-trips, whereas a single in-container rg/grep is one. Local keeps
  // the original Node/fs walk; Container runs one command and parses its output.
  search(opts: SearchOptions): Promise<SearchResult>

  // Lifecycle cleanup (e.g. stop + remove a container). No-op for Local.
  dispose(): Promise<void>
}
