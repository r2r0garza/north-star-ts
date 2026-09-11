import * as React from "react"
import hljs from "highlight.js"
import {
  AppWindow,
  Braces,
  ChevronRight,
  ExternalLink,
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileSpreadsheet,
  FileSymlink,
  FileVideo,
  FileText,
  Folder,
  Package,
  Presentation,
  RefreshCw,
} from "lucide-react"
import {
  DiCss3,
  DiHtml5,
  DiJava,
  DiJavascript1,
  DiMarkdown,
  DiNodejsSmall,
  DiPhp,
  DiPython,
  DiReact,
  DiRuby,
  DiRust,
  DiSass,
  DiSwift,
} from "react-icons/di"
import {
  SiGit,
  SiGo,
  SiKotlin,
  SiLua,
  SiPrettier,
  SiTypescript,
  SiYaml,
} from "react-icons/si"
import type { IconType } from "react-icons"
import { DiffView } from "@/components/diff-view"
import type { GitDiffResult, GitStatusEntry } from "@/types"
import { buildFileGutterAnnotations } from "@/lib/file-gutter"
import {
  affectedCachedDirectories,
  parentDirectory,
  pathAffectsSelection,
} from "@/lib/files-live-refresh"
import { placeSelectionPopover } from "@/lib/selection-popover"
import { cn } from "@/lib/utils"

type Entry = {
  name: string
  path: string
  kind: "directory" | "file" | "symlink" | "other"
}

type DirectoryState = {
  entries: Entry[]
  error: string | null
  loading: boolean
  truncated: boolean
}

const TREE_WIDTH_COOKIE = "files_tree_width"
const MIN_PANE_WIDTH = 160

function readTreeWidth(): number {
  const raw = document.cookie
    .split("; ")
    .find((row) => row.startsWith(`${TREE_WIDTH_COOKIE}=`))
    ?.split("=")[1]
  const value = Number(raw)
  return Number.isFinite(value) ? value : 260
}

function clampTreeWidth(width: number, panelWidth: number): number {
  const max = Math.max(MIN_PANE_WIDTH, panelWidth - MIN_PANE_WIDTH)
  return Math.min(Math.max(width, MIN_PANE_WIDTH), max)
}

function saveTreeWidth(width: number): void {
  document.cookie = `${TREE_WIDTH_COOKIE}=${width}; path=/; max-age=${60 * 60 * 24 * 7}`
}

const LANGUAGE_ICONS: Record<string, IconType> = {
  aac: FileAudio,
  aiff: FileAudio,
  aif: FileAudio,
  avi: FileVideo,
  csv: FileSpreadsheet,
  css: DiCss3,
  dmg: Package,
  doc: FileText,
  docx: FileText,
  exe: AppWindow,
  gif: FileImage,
  gz: FileArchive,
  go: SiGo,
  htm: DiHtml5,
  html: DiHtml5,
  flac: FileAudio,
  java: DiJava,
  jpeg: FileImage,
  jpg: FileImage,
  js: DiJavascript1,
  json: Braces,
  jsx: DiReact,
  kt: SiKotlin,
  kts: SiKotlin,
  lua: SiLua,
  m4a: FileAudio,
  md: DiMarkdown,
  midi: FileAudio,
  mkv: FileVideo,
  mov: FileVideo,
  mp3: FileAudio,
  mp4: FileVideo,
  mjs: DiNodejsSmall,
  mts: SiTypescript,
  node: DiNodejsSmall,
  pdf: FileText,
  php: DiPhp,
  pkg: Package,
  png: FileImage,
  ppt: Presentation,
  pptx: Presentation,
  py: DiPython,
  ogg: FileAudio,
  opus: FileAudio,
  rar: FileArchive,
  rb: DiRuby,
  rs: DiRust,
  sass: DiSass,
  scss: DiSass,
  swift: DiSwift,
  ts: SiTypescript,
  tar: FileArchive,
  tgz: FileArchive,
  tsx: SiTypescript,
  txt: FileText,
  wav: FileAudio,
  webm: FileVideo,
  webp: FileImage,
  wma: FileAudio,
  xls: FileSpreadsheet,
  xlsx: FileSpreadsheet,
  yaml: SiYaml,
  "7z": FileArchive,
  zip: FileArchive,
  yml: SiYaml,
}

const GIT_FILENAMES = new Set([
  ".gitignore",
  ".gitattributes",
  ".gitmodules",
  ".gitconfig",
  ".gitkeep",
])
const PRETTIER_FILENAMES = new Set([
  ".prettierrc",
  ".prettierignore",
  ".prettierrc.json",
  ".prettierrc.yml",
  ".prettierrc.yaml",
  ".prettierrc.js",
  ".prettierrc.cjs",
  "prettier.config.js",
  "prettier.config.cjs",
  "prettier.config.mjs",
])

function languageIcon(name: string): IconType | null {
  if (GIT_FILENAMES.has(name.toLowerCase())) return SiGit
  if (PRETTIER_FILENAMES.has(name.toLowerCase())) return SiPrettier
  const extension = name.split(".").pop()?.toLowerCase()
  return extension ? (LANGUAGE_ICONS[extension] ?? null) : null
}

function highlightLanguage(path: string): string | null {
  const extension = path.split(".").pop()?.toLowerCase()
  switch (extension) {
    case "css":
    case "scss":
    case "sass":
    case "html":
    case "htm":
    case "java":
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
    case "json":
    case "php":
    case "py":
    case "rb":
    case "rs":
    case "go":
    case "swift":
    case "kt":
    case "kts":
    case "lua":
    case "yaml":
    case "yml":
    case "xml":
    case "sql":
    case "sh":
    case "bash":
      return extension === "tsx" || extension === "mts" || extension === "cts"
        ? "typescript"
        : extension === "jsx"
          ? "javascript"
          : extension
    case "md":
      return "markdown"
    default:
      return null
  }
}

function languageIconColor(name: string): string {
  if (GIT_FILENAMES.has(name.toLowerCase())) return "text-orange-600"
  if (PRETTIER_FILENAMES.has(name.toLowerCase())) return "text-pink-500"
  switch (name.split(".").pop()?.toLowerCase()) {
    case "csv":
    case "xls":
    case "xlsx":
      return "text-green-600"
    case "doc":
    case "docx":
      return "text-blue-600"
    case "dmg":
    case "pkg":
      return "text-amber-600"
    case "exe":
      return "text-slate-500"
    case "gif":
    case "jpeg":
    case "jpg":
    case "png":
    case "webp":
      return "text-violet-500"
    case "aac":
    case "aiff":
    case "aif":
    case "flac":
    case "m4a":
    case "midi":
    case "mp3":
    case "ogg":
    case "opus":
    case "wav":
    case "wma":
      return "text-pink-500"
    case "pdf":
      return "text-red-600"
    case "ppt":
    case "pptx":
      return "text-orange-500"
    case "7z":
    case "gz":
    case "rar":
    case "tar":
    case "tgz":
    case "zip":
      return "text-amber-600"
    case "avi":
    case "mkv":
    case "mov":
    case "mp4":
    case "webm":
      return "text-rose-500"
    case "css":
      return "text-sky-500"
    case "go":
      return "text-cyan-500"
    case "htm":
    case "html":
      return "text-orange-500"
    case "java":
      return "text-red-500"
    case "js":
    case "mjs":
      return "text-yellow-500"
    case "mts":
    case "ts":
    case "tsx":
      return "text-blue-500"
    case "json":
      return "text-yellow-600"
    case "jsx":
      return "text-cyan-500"
    case "kt":
    case "kts":
      return "text-violet-500"
    case "lua":
      return "text-blue-500"
    case "md":
      return "text-slate-500"
    case "node":
      return "text-green-600"
    case "php":
      return "text-indigo-500"
    case "py":
      return "text-blue-500"
    case "rb":
      return "text-red-600"
    case "rs":
      return "text-orange-600"
    case "sass":
    case "scss":
      return "text-pink-500"
    case "swift":
      return "text-orange-500"
    case "yaml":
    case "yml":
      return "text-red-500"
    default:
      return "text-muted-foreground"
  }
}

function gitStatusColor(
  path: string,
  directory: boolean,
  statuses: GitStatusEntry[]
): string | undefined {
  const status = statuses.find((entry) =>
    directory ? entry.path.startsWith(`${path}/`) : entry.path === path
  )
  if (!status) return undefined
  if (status.kind === "unmerged") return "text-red-500"
  if (status.kind === "untracked" || status.index === "A")
    return "text-green-500"
  if (status.kind === "renamed" || status.index === "R") return "text-blue-500"
  if (status.index === "D" || status.worktree === "D") return "text-red-500"
  return "text-amber-500"
}

function TreeRow({
  entry,
  depth,
  selectedPath,
  expanded,
  directories,
  statuses,
  onToggle,
  onSelect,
}: {
  entry: Entry
  depth: number
  selectedPath: string | null
  expanded: Set<string>
  directories: Record<string, DirectoryState | undefined>
  statuses: GitStatusEntry[]
  onToggle: (path: string) => void
  onSelect: (path: string) => void
}) {
  const directory = entry.kind === "directory"
  const open = expanded.has(entry.path)
  const childState = directories[entry.path]
  const statusColor = gitStatusColor(entry.path, directory, statuses)
  const Icon = directory
    ? Folder
    : entry.kind === "symlink"
      ? FileSymlink
      : (languageIcon(entry.name) ?? File)
  return (
    <>
      <button
        type="button"
        role="treeitem"
        aria-expanded={directory ? open : undefined}
        aria-selected={!directory && selectedPath === entry.path}
        title={entry.path}
        onClick={() =>
          directory ? onToggle(entry.path) : onSelect(entry.path)
        }
        className={cn(
          "flex w-full min-w-0 items-center gap-1 py-1 pr-2 text-left text-xs transition-colors hover:bg-accent",
          selectedPath === entry.path && "bg-accent text-accent-foreground"
        )}
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
      >
        {directory ? (
          <ChevronRight
            className={cn(
              "size-3 shrink-0 transition-transform",
              open && "rotate-90"
            )}
          />
        ) : (
          <span className="size-3 shrink-0" />
        )}
        <Icon
          className={cn(
            "size-3.5 shrink-0",
            directory || entry.kind === "symlink"
              ? "text-muted-foreground"
              : languageIconColor(entry.name)
          )}
        />
        <span className={cn("truncate", statusColor)}>{entry.name}</span>
      </button>
      {directory && open && (
        <div role="group">
          {childState?.loading ? (
            <p className="py-1 text-center text-xs text-muted-foreground">
              Loading…
            </p>
          ) : childState?.error && childState.entries.length === 0 ? (
            <button
              type="button"
              onClick={() => onToggle(entry.path)}
              className="w-full py-1 text-xs text-destructive hover:underline"
            >
              {childState.error} Retry
            </button>
          ) : childState?.entries.length ? (
            childState.entries.map((child) => (
              <TreeRow
                key={child.path}
                entry={child}
                depth={depth + 1}
                selectedPath={selectedPath}
                expanded={expanded}
                directories={directories}
                statuses={statuses}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            ))
          ) : (
            <p className="py-1 text-center text-xs text-muted-foreground">
              Empty folder
            </p>
          )}
        </div>
      )}
    </>
  )
}

type FileSelection = {
  path: string
  startLine: number
  endLine: number
  text: string
}

function selectionLine(
  element: Node | null,
  preview: HTMLElement
): number | null {
  const row =
    element instanceof Element
      ? element.closest<HTMLElement>("[data-line]")
      : element?.parentElement?.closest<HTMLElement>("[data-line]")
  if (!row || !preview.contains(row)) return null
  const line = Number(row.dataset.line)
  return Number.isFinite(line) ? line : null
}

const FilePreviewContents = React.memo(function FilePreviewContents({
  content,
  path,
  diff,
}: {
  content: string
  path: string
  diff: GitDiffResult | null
}) {
  const lines = content.split("\n")
  const gutterAnnotations = buildFileGutterAnnotations(
    diff?.diff ?? "",
    lines.length
  )
  const language = highlightLanguage(path)
  const highlightedLines = language
    ? lines.map(
        (line) => hljs.highlight(line, { language, ignoreIllegals: true }).value
      )
    : null

  return lines.map((line, index) => {
    const lineNumber = index + 1
    const annotation = gutterAnnotations[lineNumber]
    const deletedCount =
      (annotation?.deletedBefore ?? 0) + (annotation?.deletedAfter ?? 0)
    const title = [
      annotation?.change === "added"
        ? "Added line"
        : annotation?.change === "modified"
          ? "Modified line"
          : null,
      deletedCount
        ? `${deletedCount} ${deletedCount === 1 ? "line" : "lines"} deleted`
        : null,
    ]
      .filter(Boolean)
      .join("; ")

    return (
      <div
        key={index}
        data-line={lineNumber}
        className="grid grid-cols-[3px_auto_minmax(0,1fr)] gap-x-1"
      >
        <span
          aria-label={title || undefined}
          title={title || undefined}
          className={cn(
            "relative",
            annotation?.change === "added" && "bg-emerald-500",
            annotation?.change === "modified" && "bg-amber-500",
            annotation?.deletedBefore &&
              "before:absolute before:top-0 before:-left-px before:size-0 before:border-y-[3px] before:border-r-0 before:border-l-[5px] before:border-y-transparent before:border-l-red-500 before:content-['']",
            annotation?.deletedAfter &&
              "after:absolute after:bottom-0 after:-left-px after:size-0 after:border-y-[3px] after:border-r-0 after:border-l-[5px] after:border-y-transparent after:border-l-red-500 after:content-['']"
          )}
        />
        <span
          aria-label={`Line ${lineNumber}`}
          data-line-number={lineNumber}
          className="sticky left-0 mr-3 bg-sidebar pr-1 text-right text-muted-foreground select-none before:content-[attr(data-line-number)]"
        />
        {highlightedLines ? (
          <span
            className="hljs min-w-0 break-words whitespace-pre-wrap"
            dangerouslySetInnerHTML={{
              __html: highlightedLines[index] || " ",
            }}
          />
        ) : (
          <span className="min-w-0 break-words whitespace-pre-wrap">
            {line || " "}
          </span>
        )}
      </div>
    )
  })
})

function FilePreview({
  workspace,
  path,
  revision,
  onAddSelection,
}: {
  workspace: string
  path: string | null
  revision: number
  onAddSelection: (selection: FileSelection) => void
}) {
  const previewRef = React.useRef<HTMLDivElement>(null)
  const popoverRef = React.useRef<HTMLButtonElement>(null)
  const selectionRef = React.useRef<FileSelection | null>(null)
  const [state, setState] = React.useState<{
    loading: boolean
    content: string | null
    truncated: boolean
    error: string | null
    kind?: "text" | "binary"
  }>({ loading: false, content: null, truncated: false, error: null })
  const [diff, setDiff] = React.useState<GitDiffResult | null>(null)
  const [showChanges, setShowChanges] = React.useState(false)

  const hidePopover = React.useCallback(() => {
    selectionRef.current = null
    const button = popoverRef.current
    if (button) {
      button.style.opacity = "0"
      button.style.pointerEvents = "none"
    }
  }, [])

  const updatePopover = React.useCallback(() => {
    const preview = previewRef.current
    const button = popoverRef.current
    const domSelection = window.getSelection()
    const range = domSelection?.rangeCount ? domSelection.getRangeAt(0) : null
    if (!preview || !button || !range || !selectionRef.current) {
      hidePopover()
      return
    }
    const placement = placeSelectionPopover({
      selection: range.getBoundingClientRect(),
      viewport: preview.getBoundingClientRect(),
      popoverWidth: button.offsetWidth,
      popoverHeight: button.offsetHeight,
    })
    if (!placement) {
      button.style.opacity = "0"
      button.style.pointerEvents = "none"
      return
    }
    button.style.top = `${placement.top}px`
    button.style.left = `${placement.left}px`
    button.style.opacity = "1"
    button.style.pointerEvents = "auto"
  }, [hidePopover])

  const captureSelection = React.useCallback(() => {
    const preview = previewRef.current
    const domSelection = window.getSelection()
    if (
      !preview ||
      !path ||
      !domSelection ||
      domSelection.isCollapsed ||
      !domSelection.rangeCount
    ) {
      hidePopover()
      return
    }
    const anchorLine = selectionLine(domSelection.anchorNode, preview)
    const focusLine = selectionLine(domSelection.focusNode, preview)
    const text = domSelection.toString()
    if (anchorLine === null || focusLine === null || !text.trim()) {
      hidePopover()
      return
    }
    selectionRef.current = {
      path,
      startLine: Math.min(anchorLine, focusLine),
      endLine: Math.max(anchorLine, focusLine),
      text,
    }
    updatePopover()
  }, [hidePopover, path, updatePopover])

  React.useEffect(() => {
    hidePopover()
    if (!path || !workspace) {
      setState({ loading: false, content: null, truncated: false, error: null })
      return
    }
    let cancelled = false
    setState({ loading: true, content: null, truncated: false, error: null })
    void window.cowork.files
      .readText(workspace, path)
      .then((result) => {
        if (!cancelled) setState({ loading: false, ...result })
      })
      .catch(() => {
        if (!cancelled)
          setState({
            loading: false,
            content: null,
            truncated: false,
            error: "Could not read this file.",
          })
      })
    return () => {
      cancelled = true
    }
  }, [hidePopover, path, revision, workspace])

  React.useEffect(() => {
    if (!path || !workspace) {
      setDiff(null)
      setShowChanges(false)
      return
    }
    let cancelled = false
    setShowChanges(false)
    void window.cowork.git
      .diff(workspace, path)
      .then((result) => {
        if (!cancelled) setDiff(result)
      })
      .catch(() => {
        if (!cancelled) setDiff(null)
      })
    return () => {
      cancelled = true
    }
  }, [path, revision, workspace])

  React.useLayoutEffect(() => {
    if (showChanges) {
      hidePopover()
      return
    }
    const preview = previewRef.current
    if (!preview) return
    const observer = new ResizeObserver(updatePopover)
    observer.observe(preview)
    preview.addEventListener("scroll", updatePopover)
    window.addEventListener("resize", updatePopover)
    return () => {
      observer.disconnect()
      preview.removeEventListener("scroll", updatePopover)
      window.removeEventListener("resize", updatePopover)
    }
  }, [hidePopover, showChanges, updatePopover])

  if (!path) return <EmptyPreview text="Select a file to preview it." />
  if (state.loading) return <EmptyPreview text="Loading preview…" />
  if (state.error) return <EmptyPreview text={state.error} />
  if (state.kind === "binary")
    return <EmptyPreview text="Binary files cannot be previewed here." />
  if (state.content === "") return <EmptyPreview text="This file is empty." />
  const content = state.content ?? ""
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-2 py-1.5">
        <span
          className="min-w-0 flex-1 truncate text-xs font-medium"
          title={path}
        >
          {path}
        </span>
        {diff?.diff.trim() && (
          <button
            type="button"
            onClick={() => setShowChanges((show) => !show)}
            aria-pressed={showChanges}
            title={showChanges ? "Show current file" : "Show changes from HEAD"}
            className={cn(
              "rounded px-1.5 py-0.5 text-xs transition-colors hover:bg-accent",
              showChanges && "bg-accent text-accent-foreground"
            )}
          >
            Changes
          </button>
        )}
        <button
          type="button"
          onClick={() => void window.cowork.openInEditor(workspace, path)}
          aria-label="Open in editor"
          title="Open in editor"
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ExternalLink className="size-3.5" />
        </button>
      </div>
      {state.truncated && !showChanges && (
        <p className="border-b px-2 py-1 text-xs text-muted-foreground">
          Preview truncated to the first 256 KiB.
        </p>
      )}
      {showChanges ? (
        <DiffView result={diff} className="min-h-0 flex-1 p-2" />
      ) : (
        <div className="relative min-h-0 flex-1">
          <div
            ref={previewRef}
            onMouseDown={() => {
              hidePopover()
              window.getSelection()?.removeAllRanges()
            }}
            onMouseUp={captureSelection}
            onKeyUp={captureSelection}
            className="h-full overflow-x-hidden overflow-y-auto p-2 font-mono text-xs leading-5"
          >
            <FilePreviewContents content={content} path={path} diff={diff} />
          </div>
          <button
            ref={popoverRef}
            type="button"
            onMouseDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
            onClick={() => {
              const selection = selectionRef.current
              if (!selection) return
              onAddSelection(selection)
              window.getSelection()?.removeAllRanges()
              hidePopover()
            }}
            className="pointer-events-none absolute z-20 h-7 rounded-md border bg-popover px-2 font-sans text-xs font-medium whitespace-nowrap text-popover-foreground opacity-0 shadow-md transition-opacity hover:bg-accent"
          >
            Add to chat
          </button>
        </div>
      )}
    </div>
  )
}

function EmptyPreview({ text }: { text: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-center text-xs text-muted-foreground">
      {text}
    </div>
  )
}

export function FilesPanel({
  workspace,
  selectedPath,
  onSelectedPathChange,
  onAddSelection,
}: {
  workspace: string
  selectedPath: string | null
  onSelectedPathChange: (path: string | null) => void
  onAddSelection: (selection: FileSelection) => void
}) {
  const rootRef = React.useRef<HTMLDivElement>(null)
  const requestVersion = React.useRef(0)
  const statusRequestVersion = React.useRef(0)
  const directoriesRef = React.useRef<Record<string, DirectoryState>>({})
  const selectedPathRef = React.useRef(selectedPath)
  const fileWatchRef = React.useRef<{
    updateDirectories: (directories: string[]) => Promise<void>
    unsubscribe: () => void
  } | null>(null)
  const treeWidthRef = React.useRef(readTreeWidth())
  const [directories, setDirectories] = React.useState<
    Record<string, DirectoryState>
  >({})
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set())
  const [statuses, setStatuses] = React.useState<GitStatusEntry[]>([])
  const [treeWidth, setTreeWidth] = React.useState(treeWidthRef.current)
  const [panelWidth, setPanelWidth] = React.useState(0)
  const [previewRevision, setPreviewRevision] = React.useState(0)

  directoriesRef.current = directories
  selectedPathRef.current = selectedPath

  const loadDirectory = React.useCallback(
    async (path: string, force = false) => {
      if (!workspace) return
      const cached = directoriesRef.current[path]
      if (!force && cached && !cached.error) return
      const version = requestVersion.current
      setDirectories((current) => ({
        ...current,
        [path]: {
          entries: current[path]?.entries ?? [],
          error: null,
          loading: true,
          truncated: false,
        },
      }))
      try {
        const result = await window.cowork.files.listDirectory(workspace, path)
        if (version !== requestVersion.current) return
        setDirectories((current) => ({
          ...current,
          [path]: { ...result, loading: false },
        }))
      } catch {
        if (version !== requestVersion.current) return
        setDirectories((current) => ({
          ...current,
          [path]: {
            entries: current[path]?.entries ?? [],
            error: "Could not load directory.",
            loading: false,
            truncated: false,
          },
        }))
      }
    },
    [workspace]
  )

  const refreshGitStatus = React.useCallback(() => {
    const version = requestVersion.current
    const statusVersion = ++statusRequestVersion.current
    if (!workspace) {
      setStatuses([])
      return
    }
    void window.cowork.git.status(workspace).then((result) => {
      if (
        version !== requestVersion.current ||
        statusVersion !== statusRequestVersion.current
      )
        return
      if (result?.isRepo) setStatuses(result.entries)
      else setStatuses([])
    })
  }, [workspace])

  React.useEffect(() => {
    requestVersion.current += 1
    setDirectories({})
    setExpanded(new Set())
    setStatuses([])
    if (workspace) {
      void loadDirectory("", true)
      refreshGitStatus()
    }
    // These callbacks intentionally only initiate fresh requests on workspace changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace])

  React.useEffect(() => {
    if (!workspace) return
    const interval = window.setInterval(refreshGitStatus, 2000)
    window.addEventListener("focus", refreshGitStatus)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener("focus", refreshGitStatus)
    }
  }, [refreshGitStatus, workspace])

  React.useEffect(() => {
    if (!workspace) return
    const subscription = window.cowork.files.onDidChange(workspace, (event) => {
      const cachedPaths = Object.keys(directoriesRef.current)
      const affected = affectedCachedDirectories(
        event.paths,
        cachedPaths,
        event.overflow
      )
      for (const path of affected) void loadDirectory(path, true)

      const selected = selectedPathRef.current
      if (
        selected &&
        (event.overflow ||
          event.paths.some((path) => pathAffectsSelection(path, selected)))
      ) {
        setPreviewRevision((revision) => revision + 1)
      }

      refreshGitStatus()
    })
    fileWatchRef.current = subscription
    void subscription.updateDirectories(Object.keys(directoriesRef.current))
    return () => {
      if (fileWatchRef.current === subscription) fileWatchRef.current = null
      subscription.unsubscribe()
    }
  }, [loadDirectory, refreshGitStatus, workspace])

  const watchedDirectoriesKey = JSON.stringify(Object.keys(directories).sort())
  React.useEffect(() => {
    const subscription = fileWatchRef.current
    if (!subscription) return
    const watchedDirectories = JSON.parse(watchedDirectoriesKey) as string[]
    void subscription.updateDirectories(watchedDirectories).then(() => {
      if (fileWatchRef.current !== subscription) return
      for (const path of watchedDirectories) void loadDirectory(path, true)
    })
  }, [loadDirectory, watchedDirectoriesKey])

  React.useEffect(() => {
    if (!selectedPath) return
    const parent = directories[parentDirectory(selectedPath)]
    if (
      parent &&
      !parent.loading &&
      !parent.error &&
      !parent.truncated &&
      !parent.entries.some((entry) => entry.path === selectedPath)
    ) {
      onSelectedPathChange(null)
    }
  }, [directories, onSelectedPathChange, selectedPath])

  React.useEffect(() => {
    const element = rootRef.current
    if (!element) return
    const observer = new ResizeObserver(() =>
      setPanelWidth(element.clientWidth)
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  React.useEffect(() => {
    if (!panelWidth) return
    setTreeWidth((width) => {
      const clamped = clampTreeWidth(width, panelWidth)
      treeWidthRef.current = clamped
      return clamped
    })
  }, [panelWidth])

  const toggle = (path: string) => {
    const isOpen = expanded.has(path)
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
    if (!isOpen) void loadDirectory(path)
  }
  const refresh = () => {
    requestVersion.current += 1
    const cachedPaths = Object.keys(directoriesRef.current)
    for (const path of cachedPaths.length ? cachedPaths : [""]) {
      void loadDirectory(path, true)
    }
    refreshGitStatus()
  }
  const resize = (next: number) => {
    const clamped = clampTreeWidth(next, panelWidth)
    treeWidthRef.current = clamped
    setTreeWidth(clamped)
  }

  if (!workspace)
    return (
      <EmptyPreview text="Select a workspace-backed conversation to browse its files." />
    )
  const root = directories[""]
  return (
    <div ref={rootRef} className="flex h-full min-h-0 min-w-0">
      <div className="flex min-w-0 flex-1">
        <FilePreview
          workspace={workspace}
          path={selectedPath}
          revision={previewRevision}
          onAddSelection={onAddSelection}
        />
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-valuemin={MIN_PANE_WIDTH}
        aria-valuemax={Math.max(MIN_PANE_WIDTH, panelWidth - MIN_PANE_WIDTH)}
        aria-valuenow={treeWidth}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault()
            resize(treeWidth + 16)
          }
          if (event.key === "ArrowRight") {
            event.preventDefault()
            resize(treeWidth - 16)
          }
        }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          document.body.style.userSelect = "none"
          const startX = event.clientX
          const start = treeWidth
          const move = (moveEvent: PointerEvent) =>
            resize(start - (moveEvent.clientX - startX))
          const finish = () => {
            document.body.style.userSelect = ""
            saveTreeWidth(treeWidthRef.current)
            window.removeEventListener("pointermove", move)
            window.removeEventListener("pointerup", finish)
          }
          window.addEventListener("pointermove", move)
          window.addEventListener("pointerup", finish, { once: true })
        }}
        className="w-1 shrink-0 cursor-col-resize bg-border hover:bg-ring focus-visible:bg-ring focus-visible:outline-none"
      />
      <div
        className="flex min-h-0 shrink-0 flex-col border-l"
        style={{ width: treeWidth }}
      >
        <div className="flex items-center justify-between border-b px-2 py-1.5">
          <span className="text-xs font-medium">Files</span>
          <button
            type="button"
            onClick={refresh}
            title="Refresh files"
            aria-label="Refresh files"
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <RefreshCw className="size-3.5" />
          </button>
        </div>
        <div
          role="tree"
          aria-label="Workspace files"
          className="min-h-0 flex-1 overflow-auto py-1"
        >
          {root?.loading ? (
            <p className="p-2 text-xs text-muted-foreground">Loading files…</p>
          ) : root?.error && !root.entries.length ? (
            <button
              type="button"
              onClick={refresh}
              className="p-2 text-left text-xs text-destructive hover:underline"
            >
              {root.error} Retry
            </button>
          ) : root?.entries.length ? (
            root.entries.map((entry) => (
              <TreeRow
                key={entry.path}
                entry={entry}
                depth={0}
                selectedPath={selectedPath}
                expanded={expanded}
                directories={directories}
                statuses={statuses}
                onToggle={toggle}
                onSelect={onSelectedPathChange}
              />
            ))
          ) : (
            <p className="p-2 text-xs text-muted-foreground">
              This folder is empty.
            </p>
          )}
          {root?.truncated && (
            <p className="p-2 text-xs text-muted-foreground">
              Showing the first entries only.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
