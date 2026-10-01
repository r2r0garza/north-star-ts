import type { Workspace } from "@/types"

function baseName(path: string): string {
  const parts = path.replace(/[/\\]+$/, "").split(/[/\\]/)
  return parts[parts.length - 1] || path
}

function parentPath(path: string): string {
  const normalized = path.replace(/[/\\]+$/, "")
  const separator = normalized.includes("\\") ? "\\" : "/"
  const parent = normalized.slice(0, normalized.lastIndexOf(separator))
  return parent || separator
}

function compactHome(path: string): string {
  return path
    .replace(/^\/Users\/[^/]+(?=\/|$)/, "~")
    .replace(/^\/home\/[^/]+(?=\/|$)/, "~")
    .replace(/^[A-Z]:\\Users\\[^\\]+(?=\\|$)/, "~")
}

export function WorkspaceLabel({ workspace }: { workspace: Workspace }) {
  const name = workspace.name || baseName(workspace.path)

  return (
    <span className="flex min-w-0 flex-col text-left leading-tight">
      <span className="truncate">{name}</span>
      <span className="truncate text-xs font-normal text-muted-foreground">
        {compactHome(parentPath(workspace.path))}
      </span>
    </span>
  )
}

export function WorkspaceSectionLabel({
  label,
  path,
}: {
  label: string
  path: string
}) {
  return (
    <span className="flex min-w-0 flex-col text-left leading-tight">
      <span className="truncate font-medium">{label}</span>
      <span className="truncate text-xs font-normal text-muted-foreground">
        {compactHome(parentPath(path))}
      </span>
    </span>
  )
}
