import { existsSync, readFileSync, realpathSync, statSync } from "fs"
import { basename, dirname, extname, relative, resolve, sep } from "path"
import ts from "typescript"
import { truncateForModel, toolError } from "./output"
import { TOOL_EFFECTS, type Tool, type ToolContext } from "./types"
import { resolveInWorkspace, resolveInWorkspaceReal } from "./workspace"

type Precision = "semantic" | "indexed"
type NavigationStatus = "ok" | "provider_unavailable"
type DiagnosticSeverity = "error" | "warning" | "info"

interface LocationResult {
  path: string
  line: number
  column: number
  endLine?: number
  endColumn?: number
  name?: string
  kind?: string
  container?: string
  excerpt?: string
}

interface SymbolResult extends LocationResult {
  name: string
  kind: string
  container?: string
}

interface DiagnosticRecord {
  path?: string
  line?: number
  column?: number
  severity: DiagnosticSeverity
  code?: string
  message: string
  source: string
}

interface NavigationSuccess {
  status: "ok"
  provider: string
  precision?: Precision
}

type NavigationFailure =
  | {
      status: "provider_unavailable"
      provider: string
    }
  | {
      status: "error"
      code: string
      message: string
    }

type ToolPayload<T extends object> = (NavigationSuccess & T) | NavigationFailure

const SUPPORTED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
])
const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "out",
  "dist",
  "build",
  "coverage",
])
const MAX_PROJECT_FILES = 2_000
const MAX_FILE_SIZE = 1024 * 1024
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
const QUERY_DEADLINE_MS = 2_000
const EXCERPT_RADIUS = 80

class TypeScriptNavigationProvider {
  private service?: ts.LanguageService
  private rootFiles?: string[]
  private compilerOptions?: ts.CompilerOptions
  private readonly snapshots = new Map<
    string,
    { mtimeMs: number; size: number; version: number; text: string }
  >()

  private readonly workspace: string

  constructor(workspace: string) {
    this.workspace = realpathSync(workspace)
  }

  async workspaceSymbols(args: {
    query: string
    kind?: string
    path?: string
    limit: number
  }): Promise<ToolPayload<{ symbols: SymbolResult[]; truncated: boolean }>> {
    const service = await this.getService()
    if (!service) return providerUnavailable()
    const files = this.filesUnder(args.path)
    const deadline = Date.now() + QUERY_DEADLINE_MS
    const symbols: SymbolResult[] = []
    for (const file of files) {
      if (Date.now() > deadline) break
      const tree = service.getNavigationTree(file)
      collectSymbols(tree, {
        fileName: file,
        query: args.query,
        kind: args.kind,
        limit: args.limit + 1,
        out: symbols,
        locate: (span) => this.locationForSpan(file, span),
      })
      if (symbols.length > args.limit) break
    }
    return ok({
      provider: "typescript-language-service",
      precision: "semantic",
      symbols: symbols.slice(0, args.limit),
      truncated: symbols.length > args.limit,
    })
  }

  async documentSymbols(
    path: string
  ): Promise<
    ToolPayload<{ path: string; symbols: SymbolResult[]; truncated: boolean }>
  > {
    const fileName = await this.resolveSupportedFile(path)
    if ("error" in fileName) return fileName.error
    const service = await this.getService()
    if (!service) return providerUnavailable()
    const tree = service.getNavigationTree(fileName.fileName)
    const symbols: SymbolResult[] = []
    collectSymbols(tree, {
      fileName: fileName.fileName,
      query: "",
      limit: MAX_LIMIT + 1,
      out: symbols,
      locate: (span) => this.locationForSpan(fileName.fileName, span),
    })
    return ok({
      provider: "typescript-language-service",
      precision: "semantic",
      path: relPath(this.workspace, fileName.fileName),
      symbols: symbols.slice(0, MAX_LIMIT),
      truncated: symbols.length > MAX_LIMIT,
    })
  }

  async definition(
    path: string,
    line: number,
    column: number
  ): Promise<ToolPayload<{ definitions: LocationResult[] }>> {
    const resolvedFile = await this.resolveSupportedFile(path)
    if ("error" in resolvedFile) return resolvedFile.error
    const service = await this.getService()
    if (!service) return providerUnavailable()
    const pos = this.positionAt(resolvedFile.fileName, line, column)
    if ("error" in pos) return pos.error
    const definitions = service.getDefinitionAtPosition(
      resolvedFile.fileName,
      pos.position
    )
    return ok({
      provider: "typescript-language-service",
      precision: "semantic",
      definitions: (definitions ?? []).slice(0, MAX_LIMIT).map((def) =>
        this.locationForSpan(def.fileName, def.textSpan, {
          name: def.name,
          kind: def.kind,
          container: def.containerName,
        })
      ),
    })
  }

  async references(
    path: string,
    line: number,
    column: number,
    includeDeclaration: boolean,
    limit: number
  ): Promise<
    ToolPayload<{ references: LocationResult[]; truncated: boolean }>
  > {
    const resolvedFile = await this.resolveSupportedFile(path)
    if ("error" in resolvedFile) return resolvedFile.error
    const service = await this.getService()
    if (!service) return providerUnavailable()
    const pos = this.positionAt(resolvedFile.fileName, line, column)
    if ("error" in pos) return pos.error
    const groups = service.findReferences(resolvedFile.fileName, pos.position)
    const references: LocationResult[] = []
    for (const group of groups ?? []) {
      if (includeDeclaration) {
        references.push(
          this.locationForSpan(
            group.definition.fileName,
            group.definition.textSpan,
            {
              name: group.definition.name,
              kind: group.definition.kind,
              container: group.definition.containerName,
            }
          )
        )
      }
      for (const ref of group.references) {
        if (!includeDeclaration && ref.isDefinition) continue
        references.push(this.locationForSpan(ref.fileName, ref.textSpan))
        if (references.length > limit) break
      }
      if (references.length > limit) break
    }
    return ok({
      provider: "typescript-language-service",
      precision: "semantic",
      references: references.slice(0, limit),
      truncated: references.length > limit,
    })
  }

  async hover(
    path: string,
    line: number,
    column: number
  ): Promise<
    ToolPayload<{
      path: string
      line: number
      column: number
      display: string
      documentation: string
    }>
  > {
    const resolvedFile = await this.resolveSupportedFile(path)
    if ("error" in resolvedFile) return resolvedFile.error
    const service = await this.getService()
    if (!service) return providerUnavailable()
    const pos = this.positionAt(resolvedFile.fileName, line, column)
    if ("error" in pos) return pos.error
    const info = service.getQuickInfoAtPosition(
      resolvedFile.fileName,
      pos.position
    )
    if (!info) {
      return ok({
        provider: "typescript-language-service",
        precision: "semantic",
        path: relPath(this.workspace, resolvedFile.fileName),
        line,
        column,
        display: "",
        documentation: "",
      })
    }
    return ok({
      provider: "typescript-language-service",
      precision: "semantic",
      path: relPath(this.workspace, resolvedFile.fileName),
      line,
      column,
      display: ts.displayPartsToString(info.displayParts ?? []),
      documentation: ts.displayPartsToString(info.documentation ?? []),
    })
  }

  async diagnostics(): Promise<
    ToolPayload<{
      diagnostics: DiagnosticRecord[]
      counts: ReturnType<typeof countDiagnostics>
    }>
  > {
    const service = await this.getService()
    if (!service) return providerUnavailable()
    const diagnostics: DiagnosticRecord[] = []
    for (const diag of service.getCompilerOptionsDiagnostics()) {
      diagnostics.push(this.diagnosticRecord(diag))
      if (diagnostics.length >= MAX_LIMIT) break
    }
    for (const file of this.rootFiles ?? []) {
      if (diagnostics.length >= MAX_LIMIT) break
      for (const diag of [
        ...service.getSyntacticDiagnostics(file),
        ...service.getSemanticDiagnostics(file),
      ]) {
        diagnostics.push(this.diagnosticRecord(diag))
        if (diagnostics.length >= MAX_LIMIT) break
      }
    }
    return ok({
      provider: "typescript-language-service",
      precision: "semantic",
      diagnostics,
      counts: countDiagnostics(diagnostics),
    })
  }

  private async getService(): Promise<ts.LanguageService | null> {
    if (this.service) return this.service
    const config = discoverConfig(this.workspace)
    if (!config) {
      const files = scanSupportedFiles(this.workspace)
      if (files.length === 0) return null
      this.rootFiles = files
      this.compilerOptions = {
        allowJs: true,
        checkJs: false,
        jsx: ts.JsxEmit.ReactJSX,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.ES2022,
        noEmit: true,
      }
    } else {
      const parsed = ts.parseJsonConfigFileContent(
        config.json.config ?? {},
        ts.sys,
        dirname(config.path),
        { noEmit: true, plugins: [] },
        config.path
      )
      this.rootFiles = parsed.fileNames
        .filter((file) => isSupportedFile(file))
        .filter((file) => {
          const stat = safeStat(file)
          return stat ? stat.size <= MAX_FILE_SIZE : false
        })
        .slice(0, MAX_PROJECT_FILES)
      this.compilerOptions = { ...parsed.options, noEmit: true, plugins: [] }
    }
    if ((this.rootFiles ?? []).length === 0) return null
    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => this.rootFiles ?? [],
      getScriptVersion: (fileName) =>
        String(this.snapshot(fileName)?.version ?? 0),
      getScriptSnapshot: (fileName) => {
        const snapshot = this.snapshot(fileName)
        return snapshot
          ? ts.ScriptSnapshot.fromString(snapshot.text)
          : undefined
      },
      getCurrentDirectory: () => this.workspace,
      getCompilationSettings: () => this.compilerOptions ?? {},
      getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    }
    this.service = ts.createLanguageService(
      host,
      ts.createDocumentRegistry(
        ts.sys.useCaseSensitiveFileNames,
        this.workspace
      )
    )
    return this.service
  }

  private snapshot(fileName: string): { version: number; text: string } | null {
    const stat = safeStat(fileName)
    if (!stat || !stat.isFile() || stat.size > MAX_FILE_SIZE) return null
    const existing = this.snapshots.get(fileName)
    if (
      existing &&
      existing.mtimeMs === stat.mtimeMs &&
      existing.size === stat.size
    ) {
      return existing
    }
    const text = readFileSync(fileName, "utf8")
    const next = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      version: existing ? existing.version + 1 : 1,
      text,
    }
    this.snapshots.set(fileName, next)
    return next
  }

  private async resolveSupportedFile(
    path: string
  ): Promise<{ fileName: string } | { error: NavigationFailure }> {
    let fileName: string
    try {
      fileName = await resolveInWorkspaceReal(this.workspace, path)
    } catch (err) {
      return {
        error: errorPayload(
          "bad_path",
          err instanceof Error ? err.message : "Path could not be resolved."
        ),
      }
    }
    if (!isSupportedFile(fileName)) return { error: providerUnavailable() }
    if (!existsSync(fileName)) {
      return { error: errorPayload("not_found", "File was not found.") }
    }
    return { fileName }
  }

  private positionAt(
    fileName: string,
    line: number,
    column: number
  ): { position: number } | { error: NavigationFailure } {
    if (
      !Number.isInteger(line) ||
      line < 1 ||
      !Number.isInteger(column) ||
      column < 1
    ) {
      return {
        error: errorPayload(
          "bad_args",
          "`line` and `column` must be one-based positive integers."
        ),
      }
    }
    const snapshot = this.snapshot(fileName)
    if (!snapshot) return { error: providerUnavailable() }
    const source = ts.createSourceFile(
      fileName,
      snapshot.text,
      ts.ScriptTarget.Latest,
      true
    )
    if (line > source.getLineStarts().length) {
      return { error: errorPayload("bad_args", "`line` is outside the file.") }
    }
    const position = source.getPositionOfLineAndCharacter(line - 1, column - 1)
    if (position > snapshot.text.length) {
      return {
        error: errorPayload("bad_args", "`column` is outside the line."),
      }
    }
    return { position }
  }

  private locationForSpan(
    fileName: string,
    span: ts.TextSpan,
    extra: Partial<LocationResult> = {}
  ): LocationResult {
    const snapshot = this.snapshot(fileName)
    const source = ts.createSourceFile(
      fileName,
      snapshot?.text ?? "",
      ts.ScriptTarget.Latest,
      true
    )
    const start = source.getLineAndCharacterOfPosition(span.start)
    const end = source.getLineAndCharacterOfPosition(span.start + span.length)
    return {
      path: relPath(this.workspace, fileName),
      line: start.line + 1,
      column: start.character + 1,
      endLine: end.line + 1,
      endColumn: end.character + 1,
      excerpt: snapshot
        ? boundedExcerpt(snapshot.text, span.start, span.length)
        : undefined,
      ...extra,
    }
  }

  private diagnosticRecord(diag: ts.Diagnostic): DiagnosticRecord {
    const message = ts.flattenDiagnosticMessageText(diag.messageText, "\n")
    if (!diag.file || diag.start == null) {
      return {
        severity: severity(diag.category),
        code: `TS${diag.code}`,
        message,
        source: "typescript-language-service",
      }
    }
    const loc = diag.file.getLineAndCharacterOfPosition(diag.start)
    return {
      path: relPath(this.workspace, diag.file.fileName),
      line: loc.line + 1,
      column: loc.character + 1,
      severity: severity(diag.category),
      code: `TS${diag.code}`,
      message,
      source: "typescript-language-service",
    }
  }

  private filesUnder(inputPath?: string): string[] {
    if (!inputPath) return this.rootFiles ?? []
    const target = resolveInWorkspace(this.workspace, inputPath)
    return (this.rootFiles ?? []).filter((file) => isInside(target, file))
  }
}

const providers = new Map<string, TypeScriptNavigationProvider>()

export const workspaceSymbolsTool: Tool = {
  effects: TOOL_EFFECTS.readOnlyParallel,
  executionPolicy: { timeoutMs: 120000 },
  definition: {
    type: "function",
    function: {
      name: "workspace_symbols",
      description:
        "Find TypeScript/JavaScript workspace symbols by semantic navigation tree. Results are read-only and capped.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Symbol name substring." },
          kind: { type: "string", description: "Optional symbol kind filter." },
          path: {
            type: "string",
            description: "Optional workspace-relative file or directory scope.",
          },
          limit: {
            type: "integer",
            description:
              "Maximum symbols to return. Defaults to 50; capped at 100.",
          },
        },
        required: ["query"],
      },
    },
  },
  execute: async (args, ctx) =>
    render(
      await provider(ctx).workspaceSymbols({
        query: stringArg(args.query),
        kind: optionalString(args.kind),
        path: optionalString(args.path),
        limit: limitArg(args.limit),
      })
    ),
}

export const documentSymbolsTool: Tool = {
  effects: TOOL_EFFECTS.readOnlyParallel,
  executionPolicy: { timeoutMs: 120000 },
  definition: {
    type: "function",
    function: {
      name: "document_symbols",
      description:
        "List semantic symbols declared in a TypeScript/JavaScript document.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative file path.",
          },
        },
        required: ["path"],
      },
    },
  },
  execute: async (args, ctx) =>
    render(await provider(ctx).documentSymbols(stringArg(args.path))),
}

export const goToDefinitionTool: Tool = {
  effects: TOOL_EFFECTS.readOnlyParallel,
  executionPolicy: { timeoutMs: 120000 },
  definition: {
    type: "function",
    function: {
      name: "go_to_definition",
      description:
        "Resolve semantic TypeScript/JavaScript definitions for a one-based line/column.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          line: { type: "integer" },
          column: { type: "integer" },
        },
        required: ["path", "line", "column"],
      },
    },
  },
  execute: async (args, ctx) =>
    render(
      await provider(ctx).definition(
        stringArg(args.path),
        numberArg(args.line),
        numberArg(args.column)
      )
    ),
}

export const findReferencesTool: Tool = {
  effects: TOOL_EFFECTS.readOnlyParallel,
  executionPolicy: { timeoutMs: 120000 },
  definition: {
    type: "function",
    function: {
      name: "find_references",
      description:
        "Find semantic TypeScript/JavaScript references for a one-based line/column.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          line: { type: "integer" },
          column: { type: "integer" },
          include_declaration: {
            type: "boolean",
            description:
              "Whether to include declaration locations. Defaults to true.",
          },
          limit: {
            type: "integer",
            description:
              "Maximum references to return. Defaults to 50; capped at 100.",
          },
        },
        required: ["path", "line", "column"],
      },
    },
  },
  execute: async (args, ctx) =>
    render(
      await provider(ctx).references(
        stringArg(args.path),
        numberArg(args.line),
        numberArg(args.column),
        args.include_declaration !== false,
        limitArg(args.limit)
      )
    ),
}

export const hoverTypeTool: Tool = {
  effects: TOOL_EFFECTS.readOnlyParallel,
  executionPolicy: { timeoutMs: 120000 },
  definition: {
    type: "function",
    function: {
      name: "hover_type",
      description:
        "Return TypeScript/JavaScript quick-info hover/type text for a one-based line/column.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          line: { type: "integer" },
          column: { type: "integer" },
        },
        required: ["path", "line", "column"],
      },
    },
  },
  execute: async (args, ctx) =>
    render(
      await provider(ctx).hover(
        stringArg(args.path),
        numberArg(args.line),
        numberArg(args.column)
      )
    ),
}

export async function semanticDiagnosticsForWorkspace(
  ctx: ToolContext
): Promise<string> {
  return render(await provider(ctx).diagnostics())
}

function provider(ctx: ToolContext): TypeScriptNavigationProvider {
  if (!ctx.workspace) throw new Error("Code navigation requires a workspace.")
  const key = realpathSync(ctx.workspace)
  const existing = providers.get(key)
  if (existing) return existing
  const created = new TypeScriptNavigationProvider(key)
  providers.set(key, created)
  return created
}

function discoverConfig(
  workspace: string
): { path: string; json: { config?: unknown; error?: ts.Diagnostic } } | null {
  const configPath = ts.findConfigFile(
    workspace,
    ts.sys.fileExists,
    "tsconfig.json"
  )
  if (!configPath) {
    const jsconfigPath = ts.findConfigFile(
      workspace,
      ts.sys.fileExists,
      "jsconfig.json"
    )
    if (!jsconfigPath) return null
    const json = ts.readConfigFile(jsconfigPath, ts.sys.readFile)
    if (json.error) return null
    return { path: jsconfigPath, json }
  }
  const json = ts.readConfigFile(configPath, ts.sys.readFile)
  if (json.error) return null
  return { path: configPath, json }
}

function scanSupportedFiles(workspace: string): string[] {
  const files: string[] = []
  const visit = (dir: string) => {
    if (files.length >= MAX_PROJECT_FILES) return
    let entries: string[]
    try {
      entries = ts.sys.readDirectory(
        dir,
        undefined,
        Array.from(IGNORED_DIRS, (d) => `**/${d}/**`)
      )
    } catch {
      entries = []
    }
    for (const file of entries) {
      if (files.length >= MAX_PROJECT_FILES) break
      const stat = safeStat(file)
      if (
        stat?.isFile() &&
        stat.size <= MAX_FILE_SIZE &&
        isSupportedFile(file)
      ) {
        files.push(file)
      }
    }
  }
  visit(workspace)
  return files
}

function collectSymbols(
  node: ts.NavigationTree,
  opts: {
    fileName: string
    query: string
    kind?: string
    limit: number
    out: SymbolResult[]
    locate: (span: ts.TextSpan) => LocationResult
  },
  container?: string
) {
  const matchesQuery =
    !opts.query || node.text.toLowerCase().includes(opts.query.toLowerCase())
  const matchesKind = !opts.kind || node.kind === opts.kind
  if (matchesQuery && matchesKind) {
    for (const span of node.spans) {
      if (opts.out.length >= opts.limit) return
      opts.out.push({
        ...opts.locate(span),
        name: node.text,
        kind: node.kind,
        container,
      })
    }
  }
  for (const child of node.childItems ?? []) {
    collectSymbols(child, opts, node.text || container)
    if (opts.out.length >= opts.limit) return
  }
}

function isSupportedFile(fileName: string): boolean {
  return SUPPORTED_EXTENSIONS.has(extname(fileName))
}

function safeStat(fileName: string) {
  try {
    return statSync(fileName)
  } catch {
    return null
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..")
}

function relPath(workspace: string, fileName: string): string {
  const rel = relative(workspace, fileName)
  return rel && !rel.startsWith("..") ? rel : basename(fileName)
}

function boundedExcerpt(text: string, start: number, length: number): string {
  const from = Math.max(0, start - EXCERPT_RADIUS)
  const to = Math.min(text.length, start + length + EXCERPT_RADIUS)
  return text.slice(from, to).replace(/\s+/g, " ").trim()
}

function severity(category: ts.DiagnosticCategory): DiagnosticSeverity {
  switch (category) {
    case ts.DiagnosticCategory.Warning:
      return "warning"
    case ts.DiagnosticCategory.Message:
    case ts.DiagnosticCategory.Suggestion:
      return "info"
    default:
      return "error"
  }
}

function countDiagnostics(records: DiagnosticRecord[]) {
  return {
    errors: records.filter((r) => r.severity === "error").length,
    warnings: records.filter((r) => r.severity === "warning").length,
    infos: records.filter((r) => r.severity === "info").length,
  }
}

function ok<T extends object>(payload: T): ToolPayload<T> {
  return { status: "ok", ...payload } as ToolPayload<T>
}

function providerUnavailable(): NavigationFailure {
  return {
    status: "provider_unavailable",
    provider: "typescript-language-service",
  }
}

function errorPayload(code: string, message: string): NavigationFailure {
  return { status: "error", code, message }
}

function render<T extends object>(payload: ToolPayload<T>): string {
  if (payload.status === "error")
    return toolError(payload.code, payload.message)
  return truncateForModel(JSON.stringify(payload, null, 2)).text
}

function stringArg(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function numberArg(value: unknown): number {
  return typeof value === "number" ? value : Number.NaN
}

function limitArg(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return DEFAULT_LIMIT
  }
  return Math.min(Math.floor(value), MAX_LIMIT)
}
